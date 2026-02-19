import type { AgentContext } from "../../../types/agent";
import type { AgentConfig } from "../../../types/config";
import type { ToolExecutionContext, ToolResult } from "../../../types/tool";
import type { Memory } from "../../memory";
import type { AgentObserver } from "../../observer";
import type { ToolCallLike } from "./types";

import {
  buildDiscoverProjectDocsCommand,
  buildReadProjectDocCommand,
  extractProjectDocFromToolOutput,
  parseDiscoveredProjectDocCandidates,
  resolveProjectDocsPolicy,
  selectProjectDocCandidates,
  truncateProjectDocPreview,
} from "../../docs";
import {
  buildDiscoverScriptsCommand,
  buildRegistrySyncCommand,
  SCRIPT_REGISTRY_PATH,
  updateScriptCatalogFromOutput,
} from "../../scripts";
import { updateScriptCatalog } from "../../state";
import { appendRunEvent } from "./run-events";

const DISCOVER_SCRIPTS_COMMAND = buildDiscoverScriptsCommand();
const PROJECT_DOC_DISCOVERY_MAX_FILES = 24;
const PROJECT_DOC_MAX_LINES = 220;
const PROJECT_DOC_OUTPUT_LIMIT_CHARS = 10_000;
const PROJECT_DOC_TIMEOUT_MS = 30_000;

export async function syncScriptRegistry(
  catalog: AgentContext["scriptCatalog"],
  executeTool: (toolCall: ToolCallLike) => Promise<ToolResult>
): Promise<void> {
  await executeTool({
    arguments: {
      command: buildRegistrySyncCommand(catalog),
      timeout: 30_000,
    },
    name: "execute_command",
  });
}

function buildDocsContextWithinBudget(
  loadedDocs: Array<{ content: string; path: string }>,
  maxChars: number
): Array<{ content: string; path: string }> {
  if (maxChars <= 0 || loadedDocs.length === 0) {
    return [];
  }

  const selected: Array<{ content: string; path: string }> = [];
  let usedChars = 0;

  for (const doc of loadedDocs) {
    const remainingChars = maxChars - usedChars;
    if (remainingChars <= 0) {
      break;
    }

    const maxDocChars = Math.max(0, remainingChars - (`### ${doc.path}\n\n`).length);
    if (maxDocChars <= 0) {
      break;
    }

    const boundedContent = truncateProjectDocPreview(doc.content, maxDocChars);
    if (!boundedContent.trim()) {
      continue;
    }

    selected.push({
      content: boundedContent,
      path: doc.path,
    });
    usedChars += (`### ${doc.path}\n\n${boundedContent}\n\n`).length;
  }

  return selected;
}

export async function runStartupPhase<TResult>(input: {
  config: AgentConfig;
  context: AgentContext;
  finalizeInterrupted: (input: {
    reason: string;
    step: number;
    toolCall?: null | ToolCallLike;
    toolResult?: null | ToolResult;
  }) => Promise<TResult>;
  memory: Memory;
  observer?: AgentObserver;
  runId: string;
  runToolCall: (
    toolCall: ToolCallLike,
    context?: ToolExecutionContext
  ) => Promise<ToolResult>;
  sessionId?: string;
  task: string;
  toolExecutionContext?: ToolExecutionContext;
}): Promise<{
  context: AgentContext;
  finalizedResult?: TResult;
}> {
  let context = input.context;

  const discoveredScripts = await input.runToolCall({
    arguments: {
      command: DISCOVER_SCRIPTS_COMMAND,
      timeout: 30_000,
    },
    name: "execute_command",
  }, input.toolExecutionContext);
  if (discoveredScripts.artifacts?.lifecycleEvent === "abort" || discoveredScripts.artifacts?.aborted) {
    return {
      context,
      finalizedResult: await input.finalizeInterrupted({
        reason: "startup_command_aborted",
        step: 0,
        toolCall: {
          arguments: {
            command: DISCOVER_SCRIPTS_COMMAND,
            timeout: 30_000,
          },
          name: "execute_command",
        },
        toolResult: discoveredScripts,
      }),
    };
  }
  const discoveredCatalogUpdate = updateScriptCatalogFromOutput(
    context.scriptCatalog,
    discoveredScripts.output,
    0
  );
  context = updateScriptCatalog(context, discoveredCatalogUpdate.catalog);
  await syncScriptRegistry(
    context.scriptCatalog,
    (toolCall) => input.runToolCall(toolCall, input.toolExecutionContext)
  );
  if (discoveredCatalogUpdate.notes.length > 0) {
    input.memory.addMessage(
      "assistant",
      `Startup script discovery complete. Registered or updated ${discoveredCatalogUpdate.notes.length} scripts in ${SCRIPT_REGISTRY_PATH}.`
    );
  }
  let discoveredDocCandidates: string[] = [];
  if (input.config.docContextMode !== "off") {
    const discoverDocsResult = await input.runToolCall({
      arguments: {
        command: buildDiscoverProjectDocsCommand({
          maxFiles: PROJECT_DOC_DISCOVERY_MAX_FILES,
          platform: process.platform,
        }),
        outputLimitChars: PROJECT_DOC_OUTPUT_LIMIT_CHARS,
        timeout: PROJECT_DOC_TIMEOUT_MS,
      },
      name: "execute_command",
    }, input.toolExecutionContext);
    discoveredDocCandidates = discoverDocsResult.success
      ? parseDiscoveredProjectDocCandidates(discoverDocsResult.output, PROJECT_DOC_DISCOVERY_MAX_FILES)
      : [];
  }

  const docsPolicy = resolveProjectDocsPolicy(input.task, discoveredDocCandidates);
  if (input.config.docContextMode === "off") {
    input.memory.addMessage(
      "assistant",
      "Skipping project documentation preload because AGENT_DOC_CONTEXT_MODE is set to off."
    );
    await appendRunEvent({
      event: "docs_context_skipped",
      observer: input.observer,
      payload: {
        mode: input.config.docContextMode,
        reason: "doc_context_mode_off",
      },
      phase: "planning",
      runId: input.runId,
      sessionId: input.sessionId,
      step: 0,
    });
  } else if (docsPolicy.skipAllDocs) {
    input.memory.addMessage(
      "assistant",
      "Skipping project documentation files because the user explicitly requested to avoid docs."
    );
    await appendRunEvent({
      event: "docs_context_skipped",
      observer: input.observer,
      payload: {
        mode: input.config.docContextMode,
        reason: "user_disabled_docs",
      },
      phase: "planning",
      runId: input.runId,
      sessionId: input.sessionId,
      step: 0,
    });
  } else {
    const candidateDocsToLoad = selectProjectDocCandidates({
      discoveredDocCandidates,
      maxFiles: input.config.docContextMaxFiles,
      mode: input.config.docContextMode,
      policy: docsPolicy,
      task: input.task,
    });
    const loadedDocs: Array<{ content: string; path: string }> = [];
    for (const docPath of candidateDocsToLoad) {
      const readDocResult = await input.runToolCall({
        arguments: {
          command: buildReadProjectDocCommand({
            filePath: docPath,
            maxLines: PROJECT_DOC_MAX_LINES,
            platform: process.platform,
          }),
          outputLimitChars: PROJECT_DOC_OUTPUT_LIMIT_CHARS,
          timeout: PROJECT_DOC_TIMEOUT_MS,
        },
        name: "execute_command",
      }, input.toolExecutionContext);
      if (!readDocResult.success) {
        continue;
      }

      const extractedDoc = extractProjectDocFromToolOutput({
        filePath: docPath,
        toolOutput: readDocResult.output,
      });
      if (!extractedDoc) {
        continue;
      }

      loadedDocs.push({
        content: truncateProjectDocPreview(extractedDoc),
        path: docPath,
      });
    }

    const boundedDocs = buildDocsContextWithinBudget(loadedDocs, input.config.docContextMaxChars);
    if (docsPolicy.excludedDocPaths.length > 0) {
      input.memory.addMessage(
        "assistant",
        `Skipped project docs per user request: ${docsPolicy.excludedDocPaths.join(", ")}.`
      );
    }
    if (boundedDocs.length > 0) {
      const docsContext = boundedDocs
        .map((doc) => `### ${doc.path}\n${doc.content}`)
        .join("\n\n");
      input.memory.addMessage(
        "system",
        `Project documentation context (follow this unless the user overrides):\n\n${docsContext}`
      );
      input.memory.addMessage(
        "assistant",
        `Loaded project documentation context from: ${boundedDocs.map((doc) => doc.path).join(", ")}.`
      );
      await appendRunEvent({
        event: "docs_context_loaded",
        observer: input.observer,
        payload: {
          discoveredCandidates: discoveredDocCandidates.length,
          injectedChars: docsContext.length,
          loadedPaths: boundedDocs.map((doc) => doc.path),
          mode: input.config.docContextMode,
        },
        phase: "planning",
        runId: input.runId,
        sessionId: input.sessionId,
        step: 0,
      });
    } else {
      const reason = candidateDocsToLoad.length > 0
        ? "docs_read_empty_or_budget_exhausted"
        : "no_targeted_doc_candidates";
      input.memory.addMessage(
        "assistant",
        candidateDocsToLoad.length > 0
          ? "Project docs were selected but none were loaded after read/budget constraints."
          : "No targeted project documentation files were selected for preload."
      );
      await appendRunEvent({
        event: "docs_context_skipped",
        observer: input.observer,
        payload: {
          discoveredCandidates: discoveredDocCandidates.length,
          mode: input.config.docContextMode,
          reason,
          selectedCandidates: candidateDocsToLoad.length,
        },
        phase: "planning",
        runId: input.runId,
        sessionId: input.sessionId,
        step: 0,
      });
    }
  }

  return {
    context,
  };
}
