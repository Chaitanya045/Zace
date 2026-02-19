import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { LlmClient } from "../../llm/client";
import type { AgentContext, AgentState } from "../../types/agent";
import type { AgentConfig } from "../../types/config";
import type { AbortSignalLike, ToolExecutionContext, ToolResult } from "../../types/tool";
import type { AgentObserver } from "../observer";

import { probeFiles as probeLspFiles } from "../../lsp";
import { buildSystemPrompt } from "../../prompts/system";
import { allTools } from "../../tools";
import { appendSessionMessage, appendSessionRunEvent, getSessionFilePath } from "../../tools/session";
import { AgentError } from "../../utils/errors";
import { log, logError, logStep } from "../../utils/logger";
import {
  buildApprovalCommandSignature,
  buildPendingApprovalPrompt,
  createPendingApprovalAction,
  findApprovalRuleDecision,
} from "../approval";
import { maybeCompactContext } from "../compaction";
import {
  discoverAutomaticCompletionGates,
  describeCompletionPlan,
  mergeCompletionGates,
  resolveCompletionPlan,
  type CompletionGate,
} from "../completion";
import {
  buildCompletionFailureMessage,
  parsePlannerCompletionGates,
  shouldBlockForFreshness,
  shouldBlockForMaskedGates,
  type CompletionGateResult,
} from "../completion/gate-evaluation";
import {
  buildDiscoverProjectDocsCommand,
  buildReadProjectDocCommand,
  extractProjectDocFromToolOutput,
  parseDiscoveredProjectDocCandidates,
  resolveProjectDocsPolicy,
  selectProjectDocCandidates,
  truncateProjectDocPreview,
} from "../docs";
import { classifyRetry } from "../execution/retry-classifier";
import { buildToolMemoryDigest } from "../execution/tool-memory-digest";
import { analyzeToolResult, executeToolCall } from "../executor";
import {
  buildToolLoopSignature,
} from "../guardrails";
import {
  advanceLspBootstrapState,
  buildLspBootstrapRequirementMessage,
  deriveLspBootstrapSignal,
  shouldBlockForBootstrap,
  shouldTrackPendingLspFiles,
  type LspBootstrapState,
} from "../lsp-bootstrap/state-machine";
import { Memory } from "../memory";
import { plan } from "../planner";
import { assessCommandSafety } from "../safety";
import {
  buildDiscoverScriptsCommand,
  buildRegistrySyncCommand,
  SCRIPT_REGISTRY_PATH,
  updateScriptCatalogFromOutput,
} from "../scripts";
import {
  buildToolCallSignature,
  detectPreExecutionDoomLoop,
  detectStagnation,
} from "../stability";
import { addStep, createInitialContext, transitionState, updateScriptCatalog } from "../state";

export interface AgentResult {
  success: boolean;
  finalState: AgentState;
  context: AgentContext;
  message: string;
}

export interface RunAgentLoopOptions {
  approvedCommandSignaturesOnce?: string[];
  abortSignal?: AbortSignalLike;
  executeToolCall?: (toolCall: {
    arguments: Record<string, unknown>;
    name: string;
  }, context?: ToolExecutionContext) => Promise<ToolResult>;
  observer?: AgentObserver;
  sessionId?: string;
}

const DISCOVER_SCRIPTS_COMMAND = buildDiscoverScriptsCommand();
const MAX_CONSECUTIVE_NO_TOOL_CONTINUES = 2;
const PROJECT_DOC_DISCOVERY_MAX_FILES = 24;
const PROJECT_DOC_MAX_LINES = 220;
const PROJECT_DOC_OUTPUT_LIMIT_CHARS = 10_000;
const PROJECT_DOC_TIMEOUT_MS = 30_000;
const OVERWRITE_REDIRECT_TARGET_REGEX = /(?:^|[\s;|&])(?:\d*)>(?!>|&)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/gu;

type CommandApprovalResult =
  | {
      commandSignature: string;
      message: string;
      reason: string;
      status: "request_user";
    }
  | {
      message: string;
      scope: "session" | "workspace";
      status: "deny";
    }
  | {
      requiredApproval: boolean;
      scope: "once" | "session" | "workspace";
      status: "allow";
    };

async function appendRunEvent(input: {
  event: string;
  observer?: AgentObserver;
  payload?: Record<string, unknown>;
  phase: "approval" | "executing" | "finalizing" | "planning";
  runId: string;
  sessionId?: string;
  step: number;
}): Promise<void> {
  input.observer?.onRunEvent?.({
    event: input.event,
    phase: input.phase,
    step: input.step,
  });

  if (!input.sessionId) {
    return;
  }

  try {
    await appendSessionRunEvent(input.sessionId, {
      event: input.event,
      payload: input.payload,
      phase: input.phase,
      runId: input.runId,
      step: input.step,
    });
  } catch (error) {
    logError("Failed to append run event", error);
  }
}

async function syncScriptRegistry(
  catalog: AgentContext["scriptCatalog"],
  executeTool: (toolCall: {
    arguments: Record<string, unknown>;
    name: string;
  }) => Promise<ToolResult>
): Promise<void> {
  await executeTool({
    arguments: {
      command: buildRegistrySyncCommand(catalog),
      timeout: 30_000,
    },
    name: "execute_command",
  });
}

async function runCompletionGates(
  gates: CompletionGate[],
  workingDirectory: string,
  executeTool: (toolCall: {
    arguments: Record<string, unknown>;
    name: string;
  }) => Promise<ToolResult>
): Promise<CompletionGateResult[]> {
  const results: CompletionGateResult[] = [];

  for (const gate of gates) {
    let result: ToolResult;
    try {
      result = await executeTool({
        arguments: {
          command: gate.command,
          cwd: workingDirectory,
        },
        name: "execute_command",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown gate execution error";
      result = {
        error: errorMessage,
        output: errorMessage,
        success: false,
      };
    }
    results.push({ gate, result });
  }

  return results;
}

function getExecuteCommandText(argumentsObject: Record<string, unknown>): string | undefined {
  const commandValue = argumentsObject.command;
  if (typeof commandValue !== "string") {
    return undefined;
  }

  const command = commandValue.trim();
  if (!command) {
    return undefined;
  }

  return command;
}

function getExecuteCommandWorkingDirectory(argumentsObject: Record<string, unknown>): string | undefined {
  const cwdValue = argumentsObject.cwd;
  if (typeof cwdValue !== "string") {
    return undefined;
  }

  const cwd = cwdValue.trim();
  if (!cwd) {
    return undefined;
  }

  return cwd;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function extractOverwriteRedirectTargets(command: string): string[] {
  const targets = new Set<string>();
  for (const match of command.matchAll(OVERWRITE_REDIRECT_TARGET_REGEX)) {
    const rawTarget = match[1];
    if (!rawTarget) {
      continue;
    }

    const normalized = stripWrappingQuotes(rawTarget.trim());
    if (!normalized) {
      continue;
    }

    targets.add(normalized);
  }

  return Array.from(targets).sort((left, right) => left.localeCompare(right));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isDynamicShellPath(value: string): boolean {
  return /[`$*?{}()]/u.test(value);
}

async function buildCommandSafetyContext(
  command: string,
  workingDirectory: string
): Promise<{
  overwriteRedirectTargets: Array<{
    exists: "no" | "unknown" | "yes";
    rawPath: string;
    resolvedPath: string;
  }>;
  workingDirectory: string;
}> {
  const targets = extractOverwriteRedirectTargets(command);
  const overwriteRedirectTargets = await Promise.all(
    targets.slice(0, 12).map(async (target) => {
      if (
        !target ||
        target === "-" ||
        target === "/dev/null" ||
        target.toLowerCase() === "nul" ||
        target.startsWith("~") ||
        isDynamicShellPath(target)
      ) {
        return {
          exists: "unknown" as const,
          rawPath: target,
          resolvedPath: target || "<empty>",
        };
      }

      const resolvedPath = resolve(workingDirectory, target);
      return {
        exists: (await pathExists(resolvedPath)) ? "yes" as const : "no" as const,
        rawPath: target,
        resolvedPath,
      };
    })
  );

  return {
    overwriteRedirectTargets,
    workingDirectory,
  };
}

async function getDestructiveCommandReason(
  client: LlmClient,
  config: AgentConfig,
  command: string,
  options?: {
    workingDirectory?: string;
  }
): Promise<null | string> {
  if (!config.requireRiskyConfirmation || command.includes(config.riskyConfirmationToken)) {
    return null;
  }

  const workingDirectory = resolve(options?.workingDirectory ?? process.cwd());
  const safetyAssessment = await assessCommandSafety(
    client,
    command,
    await buildCommandSafetyContext(command, workingDirectory)
  );
  if (!safetyAssessment.isDestructive) {
    return null;
  }

  return safetyAssessment.reason;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const parsed = Math.trunc(value);
  if (parsed < 0) {
    return undefined;
  }

  return parsed;
}

function getRetryConfiguration(
  toolCall: { arguments: Record<string, unknown>; name: string },
  defaults: {
    maxRetries: number;
    retryMaxDelayMs: number;
  }
): {
  maxRetries: number;
  retryMaxDelayMs?: number;
} {
  if (toolCall.name !== "execute_command") {
    return {
      maxRetries: defaults.maxRetries,
      retryMaxDelayMs: defaults.retryMaxDelayMs,
    };
  }

  const requestedMaxRetries = parseNonNegativeInteger(toolCall.arguments.maxRetries);
  const retryMaxDelayMs = parseNonNegativeInteger(toolCall.arguments.retryMaxDelayMs);

  return {
    maxRetries: Math.min(
      requestedMaxRetries === undefined ? defaults.maxRetries : requestedMaxRetries,
      defaults.maxRetries
    ),
    retryMaxDelayMs: Math.min(
      retryMaxDelayMs === undefined ? defaults.retryMaxDelayMs : retryMaxDelayMs,
      defaults.retryMaxDelayMs
    ),
  };
}

function getRetryDelayMs(
  retryDelayMs: number | undefined,
  retryMaxDelayMs: number | undefined
): number {
  if (typeof retryDelayMs !== "number" || !Number.isFinite(retryDelayMs)) {
    return 0;
  }

  const normalizedDelay = Math.max(0, Math.trunc(retryDelayMs));
  if (retryMaxDelayMs === undefined) {
    return normalizedDelay;
  }

  return Math.min(normalizedDelay, retryMaxDelayMs);
}

function emitDiagnosticsObserverEvent(
  observer: AgentObserver | undefined,
  step: number,
  toolResult: ToolResult
): void {
  const artifacts = toolResult.artifacts;
  if (!artifacts?.lspDiagnosticsIncluded) {
    return;
  }

  const files = artifacts.lspDiagnosticsFiles ?? [];
  const errorCount = artifacts.lspErrorCount ?? 0;
  observer?.onDiagnostics?.({
    errorCount,
    files,
    step,
  });
}

type LspBootstrapContext = {
  attemptedCommands: string[];
  lastFailureReason: null | string;
  pendingChangedFiles: Set<string>;
  provisionAttempts: number;
  state: LspBootstrapState;
};

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function ensureUserFacingQuestion(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "What would you like me to work on next?";
  }

  if (/\?\s*$/u.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed} What should I do next?`;
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

export async function runAgentLoop(
  client: LlmClient,
  config: AgentConfig,
  task: string,
  options?: RunAgentLoopOptions
): Promise<AgentResult> {
  log(`Starting agent loop for task: ${task}`);

  const observer = options?.observer;
  const sessionId = options?.sessionId;
  const abortSignal = options?.abortSignal;
  const toolExecutionContext: ToolExecutionContext | undefined = abortSignal
    ? { abortSignal }
    : undefined;
  const runId = randomUUID();
  const sessionFilePath = sessionId ? getSessionFilePath(sessionId) : undefined;
  const memory = new Memory({
    messageSink: sessionId
      ? async (message) => {
          await appendSessionMessage(sessionId, {
            content: message.content,
            role: message.role,
          });
        }
      : undefined,
  });
  let context = createInitialContext(task, config.maxSteps);
  let completionPlan = resolveCompletionPlan(task);
  let consecutiveNoToolContinues = 0;
  let lastToolLoopSignature = "";
  let lastToolLoopSignatureCount = 0;
  let lastCompletionGateFailure: null | string = null;
  let lastExecutionWorkingDirectory = process.cwd();
  let lastSuccessfulValidationStep: number | undefined;
  let lastWriteWorkingDirectory: string | undefined;
  let lastWriteStep: number | undefined;
  let lastWriteLspErrorCount: number | undefined;
  const lspBootstrap: LspBootstrapContext = {
    attemptedCommands: [],
    lastFailureReason: null,
    pendingChangedFiles: new Set<string>(),
    provisionAttempts: 0,
    state: "idle",
  };
  const lspServerConfigAbsolutePath = resolve(config.lspServerConfigPath);
  const toolCallSignatureHistory: string[] = [];
  const onceApprovedSignatures = new Set(options?.approvedCommandSignaturesOnce ?? []);
  const runToolCall = options?.executeToolCall ?? executeToolCall;
  const getCompletionCriteria = (): string[] => describeCompletionPlan(completionPlan);
  const finalizeResult = async (
    result: AgentResult,
    step: number,
    reason: string
  ): Promise<AgentResult> => {
    await appendRunEvent({
      event: "final_state_set",
      observer,
      payload: {
        finalState: result.finalState,
        reason,
        success: result.success,
      },
      phase: "finalizing",
      runId,
      sessionId,
      step,
    });

    return result;
  };
  const finalizeInterrupted = async (input: {
    step: number;
    reason: string;
    toolCall?: null | { arguments: Record<string, unknown>; name: string };
    toolResult?: null | ToolResult;
  }): Promise<AgentResult> => {
    await appendRunEvent({
      event: "run_interrupted",
      observer,
      payload: {
        reason: input.reason,
      },
      phase: "finalizing",
      runId,
      sessionId,
      step: input.step,
    });
    const message = "Run interrupted. No further actions were taken.";
    context = addStep(context, {
      reasoning: `Interrupted: ${input.reason}`,
      state: "interrupted",
      step: input.step,
      toolCall: input.toolCall ?? null,
      toolResult: input.toolResult ?? null,
    });
    return await finalizeResult({
      context,
      finalState: "interrupted",
      message,
      success: false,
    }, input.step, input.reason);
  };
  const recordCompletionValidationBlocked = async (
    step: number,
    reason: string,
    extraPayload?: Record<string, unknown>
  ): Promise<void> => {
    await appendRunEvent({
      event: "completion_validation_blocked",
      observer,
      payload: {
        reason,
        ...extraPayload,
      },
      phase: "finalizing",
      runId,
      sessionId,
      step,
    });
  };
  const resolveCommandApproval = async (input: {
    command: string;
    workingDirectory?: string;
  }): Promise<CommandApprovalResult> => {
    const destructiveReason = await getDestructiveCommandReason(client, config, input.command, {
      workingDirectory: input.workingDirectory,
    });
    if (!destructiveReason) {
      return {
        requiredApproval: false,
        scope: "once",
        status: "allow",
      };
    }

    const commandSignature = buildApprovalCommandSignature(input.command, input.workingDirectory);
    if (onceApprovedSignatures.has(commandSignature)) {
      onceApprovedSignatures.delete(commandSignature);
      return {
        requiredApproval: true,
        scope: "once",
        status: "allow",
      };
    }

    const savedRule = await findApprovalRuleDecision({
      commandSignature,
      config,
      sessionId,
    });
    if (savedRule) {
      if (savedRule.decision === "allow") {
        return {
          requiredApproval: true,
          scope: savedRule.scope,
          status: "allow",
        };
      }
      return {
        message:
          `Command denied by saved ${savedRule.scope} approval rule.\n` +
          `Command: ${input.command}\n` +
          `Rule pattern: ${savedRule.pattern}`,
        scope: savedRule.scope,
        status: "deny",
      };
    }

    const confirmationMessage = buildPendingApprovalPrompt({
      command: input.command,
      reason: destructiveReason,
      riskyConfirmationToken: config.riskyConfirmationToken,
    });
    if (sessionId && config.approvalMemoryEnabled) {
      await createPendingApprovalAction({
        command: input.command,
        commandSignature,
        prompt: confirmationMessage,
        reason: destructiveReason,
        runId,
        sessionId,
        workingDirectory: input.workingDirectory,
      });
    }
    return {
      commandSignature,
      message: confirmationMessage,
      reason: destructiveReason,
      status: "request_user",
    };
  };

  // Build dynamic system prompt with runtime context
  const systemPrompt = buildSystemPrompt({
    availableTools: allTools.map((tool) => tool.name),
    commandAllowPatterns: config.commandAllowPatterns,
    commandDenyPatterns: config.commandDenyPatterns,
    completionCriteria: getCompletionCriteria(),
    currentDirectory: process.cwd(),
    maxSteps: config.maxSteps,
    platform: process.platform,
    requireRiskyConfirmation: config.requireRiskyConfirmation,
    riskyConfirmationToken: config.riskyConfirmationToken,
    sessionFilePath,
    sessionId,
    verbose: config.verbose,
  });

  // Initialize with system prompt
  memory.addMessage("system", systemPrompt);

  try {
    if (sessionId) {
      await appendSessionMessage(sessionId, {
        content: task,
        role: "user",
      });
    }
    await appendRunEvent({
      event: "run_started",
      observer,
      payload: {
        maxSteps: config.maxSteps,
      },
      phase: "planning",
      runId,
      sessionId,
      step: 0,
    });

    if (abortSignal?.aborted) {
      return await finalizeInterrupted({
        reason: "abort_signal_pre_startup",
        step: 0,
      });
    }

    const discoveredScripts = await runToolCall({
      arguments: {
        command: DISCOVER_SCRIPTS_COMMAND,
        timeout: 30_000,
      },
      name: "execute_command",
    }, toolExecutionContext);
    if (discoveredScripts.artifacts?.lifecycleEvent === "abort" || discoveredScripts.artifacts?.aborted) {
      return await finalizeInterrupted({
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
      });
    }
    const discoveredCatalogUpdate = updateScriptCatalogFromOutput(
      context.scriptCatalog,
      discoveredScripts.output,
      0
    );
    context = updateScriptCatalog(context, discoveredCatalogUpdate.catalog);
    await syncScriptRegistry(context.scriptCatalog, (toolCall) => runToolCall(toolCall, toolExecutionContext));
    if (discoveredCatalogUpdate.notes.length > 0) {
      memory.addMessage(
        "assistant",
        `Startup script discovery complete. Registered or updated ${discoveredCatalogUpdate.notes.length} scripts in ${SCRIPT_REGISTRY_PATH}.`
      );
    }
    let discoveredDocCandidates: string[] = [];
    if (config.docContextMode !== "off") {
      const discoverDocsResult = await runToolCall({
        arguments: {
          command: buildDiscoverProjectDocsCommand({
            maxFiles: PROJECT_DOC_DISCOVERY_MAX_FILES,
            platform: process.platform,
          }),
          outputLimitChars: PROJECT_DOC_OUTPUT_LIMIT_CHARS,
          timeout: PROJECT_DOC_TIMEOUT_MS,
        },
        name: "execute_command",
      }, toolExecutionContext);
      discoveredDocCandidates = discoverDocsResult.success
        ? parseDiscoveredProjectDocCandidates(discoverDocsResult.output, PROJECT_DOC_DISCOVERY_MAX_FILES)
        : [];
    }

    const docsPolicy = resolveProjectDocsPolicy(task, discoveredDocCandidates);
    if (config.docContextMode === "off") {
      memory.addMessage(
        "assistant",
        "Skipping project documentation preload because AGENT_DOC_CONTEXT_MODE is set to off."
      );
      await appendRunEvent({
        event: "docs_context_skipped",
        observer,
        payload: {
          mode: config.docContextMode,
          reason: "doc_context_mode_off",
        },
        phase: "planning",
        runId,
        sessionId,
        step: 0,
      });
    } else if (docsPolicy.skipAllDocs) {
      memory.addMessage(
        "assistant",
        "Skipping project documentation files because the user explicitly requested to avoid docs."
      );
      await appendRunEvent({
        event: "docs_context_skipped",
        observer,
        payload: {
          mode: config.docContextMode,
          reason: "user_disabled_docs",
        },
        phase: "planning",
        runId,
        sessionId,
        step: 0,
      });
    } else {
      const candidateDocsToLoad = selectProjectDocCandidates({
        discoveredDocCandidates,
        maxFiles: config.docContextMaxFiles,
        mode: config.docContextMode,
        policy: docsPolicy,
        task,
      });
      const loadedDocs: Array<{ content: string; path: string }> = [];
      for (const docPath of candidateDocsToLoad) {
        const readDocResult = await runToolCall({
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
        }, toolExecutionContext);
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

      const boundedDocs = buildDocsContextWithinBudget(loadedDocs, config.docContextMaxChars);
      if (docsPolicy.excludedDocPaths.length > 0) {
        memory.addMessage(
          "assistant",
          `Skipped project docs per user request: ${docsPolicy.excludedDocPaths.join(", ")}.`
        );
      }
      if (boundedDocs.length > 0) {
        const docsContext = boundedDocs
          .map((doc) => `### ${doc.path}\n${doc.content}`)
          .join("\n\n");
        memory.addMessage(
          "system",
          `Project documentation context (follow this unless the user overrides):\n\n${docsContext}`
        );
        memory.addMessage(
          "assistant",
          `Loaded project documentation context from: ${boundedDocs.map((doc) => doc.path).join(", ")}.`
        );
        await appendRunEvent({
          event: "docs_context_loaded",
          observer,
          payload: {
            discoveredCandidates: discoveredDocCandidates.length,
            injectedChars: docsContext.length,
            loadedPaths: boundedDocs.map((doc) => doc.path),
            mode: config.docContextMode,
          },
          phase: "planning",
          runId,
          sessionId,
          step: 0,
        });
      } else {
        const reason = candidateDocsToLoad.length > 0
          ? "docs_read_empty_or_budget_exhausted"
          : "no_targeted_doc_candidates";
        memory.addMessage(
          "assistant",
          candidateDocsToLoad.length > 0
            ? "Project docs were selected but none were loaded after read/budget constraints."
            : "No targeted project documentation files were selected for preload."
        );
        await appendRunEvent({
          event: "docs_context_skipped",
          observer,
          payload: {
            discoveredCandidates: discoveredDocCandidates.length,
            mode: config.docContextMode,
            reason,
            selectedCandidates: candidateDocsToLoad.length,
          },
          phase: "planning",
          runId,
          sessionId,
          step: 0,
        });
      }
    }

    while (context.currentStep < context.maxSteps) {
      const stepNumber = context.currentStep + 1;
      if (abortSignal?.aborted) {
        return await finalizeInterrupted({
          reason: "abort_signal_pre_step",
          step: stepNumber,
        });
      }
      logStep(stepNumber, `Starting step ${stepNumber}/${context.maxSteps}`);
      observer?.onStepStart?.({
        maxSteps: context.maxSteps,
        step: stepNumber,
      });

      // Planning phase
      context = transitionState(context, "planning");
      await appendRunEvent({
        event: "plan_started",
        observer,
        phase: "planning",
        runId,
        sessionId,
        step: stepNumber,
      });
      await appendRunEvent({
        event: "planner_schema_mode_selected",
        observer,
        payload: {
          mode: config.plannerOutputMode ?? "auto",
          strict: config.plannerSchemaStrict ?? true,
        },
        phase: "planning",
        runId,
        sessionId,
        step: stepNumber,
      });
      const planResult = await plan(client, context, memory, {
        completionCriteria: getCompletionCriteria(),
        onStreamEnd: () => {
          observer?.onPlannerStreamEnd?.();
        },
        onStreamStart: () => {
          observer?.onPlannerStreamStart?.();
        },
        onStreamToken: (token) => {
          observer?.onPlannerStreamToken?.(token);
        },
        plannerMaxInvalidArtifactChars: config.plannerMaxInvalidArtifactChars,
        plannerOutputMode: config.plannerOutputMode,
        plannerParseMaxRepairs: config.plannerParseMaxRepairs,
        plannerParseRetryOnFailure: config.plannerParseRetryOnFailure,
        plannerSchemaStrict: config.plannerSchemaStrict,
        stream: config.stream,
      });
      if (planResult.schemaUnsupportedReason) {
        await appendRunEvent({
          event: "planner_schema_unsupported",
          observer,
          payload: {
            parseMode: planResult.parseMode,
            reason: planResult.schemaUnsupportedReason,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      if (planResult.llmRequestNormalized) {
        await appendRunEvent({
          event: "llm_request_normalized",
          observer,
          payload: {
            parseMode: planResult.parseMode,
            reasons: planResult.llmRequestNormalizationReasons ?? [],
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      if (planResult.llmRequestRejected) {
        await appendRunEvent({
          event: "llm_request_rejected",
          observer,
          payload: {
            parseMode: planResult.parseMode,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      if (planResult.plannerFallbackPromptMode) {
        await appendRunEvent({
          event: "planner_fallback_prompt_mode",
          observer,
          payload: {
            outputMode: config.plannerOutputMode ?? "auto",
            parseMode: planResult.parseMode,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      if (planResult.invalidOutputArtifactPath) {
        await appendRunEvent({
          event: "planner_invalid_output_captured",
          observer,
          payload: {
            artifactPath: planResult.invalidOutputArtifactPath,
            rawInvalidCount: planResult.rawInvalidCount,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      if (planResult.rawInvalidCount > 0) {
        await appendRunEvent({
          event: "planner_parse_failed",
          observer,
          payload: {
            parseAttempts: planResult.parseAttempts,
            parseMode: planResult.parseMode,
            rawInvalidCount: planResult.rawInvalidCount,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      if (planResult.parseAttempts > 1) {
        await appendRunEvent({
          event: "planner_parse_repair_attempted",
          observer,
          payload: {
            parseAttempts: planResult.parseAttempts,
            parseMode: planResult.parseMode,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      if (planResult.parseMode === "repair_json" || planResult.parseMode === "legacy") {
        await appendRunEvent({
          event: "planner_parse_recovered",
          observer,
          payload: {
            parseAttempts: planResult.parseAttempts,
            parseMode: planResult.parseMode,
            rawInvalidCount: planResult.rawInvalidCount,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      if (planResult.parseMode === "failed") {
        await appendRunEvent({
          event: "planner_parse_exhausted",
          observer,
          payload: {
            parseAttempts: planResult.parseAttempts,
            rawInvalidCount: planResult.rawInvalidCount,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
        await appendRunEvent({
          event: "planner_blocked_parse_exhausted",
          observer,
          payload: {
            invalidOutputArtifactPath: planResult.invalidOutputArtifactPath,
            parseAttempts: planResult.parseAttempts,
            rawInvalidCount: planResult.rawInvalidCount,
          },
          phase: "planning",
          runId,
          sessionId,
          step: stepNumber,
        });
      }
      await appendRunEvent({
        event: "plan_parsed",
        observer,
        payload: {
          action: planResult.action,
          hasToolCall: Boolean(planResult.toolCall),
          parseAttempts: planResult.parseAttempts,
          parseMode: planResult.parseMode,
          rawInvalidCount: planResult.rawInvalidCount,
          transportStructured: planResult.transportStructured,
        },
        phase: "planning",
        runId,
        sessionId,
        step: stepNumber,
      });

      // Add planning reasoning to memory
      memory.addMessage("assistant", `Planning: ${planResult.reasoning}`);

      const compactionResult = await maybeCompactContext({
        client,
        config,
        memory,
        plannerInputTokens: planResult.usage?.inputTokens,
        stepNumber,
      });
      if (compactionResult.compacted) {
        const ratioPercent =
          typeof compactionResult.usageRatio === "number"
            ? Math.round(compactionResult.usageRatio * 100)
            : Math.round(config.compactionTriggerRatio * 100);
        observer?.onCompaction?.({
          ratioPercent,
          step: stepNumber,
        });
        memory.addMessage(
          "assistant",
          `Context compacted after planner input reached ${String(ratioPercent)}% of model context.`
        );
      }

      // Handle different plan outcomes
      if (planResult.action === "complete") {
        const strictCompletionValidation = config.completionValidationMode === "strict";
        const validationWorkingDirectory = lastWriteWorkingDirectory ?? lastExecutionWorkingDirectory;
        const lspBootstrapBlocking = shouldBlockForBootstrap({
          completionRequireLsp: config.completionRequireLsp,
          lspBootstrapBlockOnFailed: config.lspBootstrapBlockOnFailed,
          lspEnabled: config.lspEnabled,
          lspState: lspBootstrap.state,
        });
        if (lspBootstrapBlocking) {
          const bootstrapMessage = buildLspBootstrapRequirementMessage(
            config.lspServerConfigPath,
            Array.from(lspBootstrap.pendingChangedFiles),
            lspBootstrap.lastFailureReason ?? undefined
          );
          const failureMessage =
            `Completion blocked until LSP bootstrap is resolved. ${bootstrapMessage}`;
          lastCompletionGateFailure = failureMessage;
          await recordCompletionValidationBlocked(stepNumber, failureMessage, {
            lspBootstrapState: lspBootstrap.state,
            lspFailureReason: lspBootstrap.lastFailureReason,
            provisionAttempts: lspBootstrap.provisionAttempts,
          });

          if (!config.lspAutoProvision || lspBootstrap.provisionAttempts >= config.lspProvisionMaxAttempts) {
            const attemptedCommandsText = lspBootstrap.attemptedCommands.length > 0
              ? `\nRecent bootstrap commands:\n- ${lspBootstrap.attemptedCommands.join("\n- ")}`
              : "";
            const waitMessage =
              `${failureMessage}\nReached bootstrap remediation limit (${String(config.lspProvisionMaxAttempts)} attempts).` +
              `${attemptedCommandsText}`;
            memory.addMessage("assistant", waitMessage);
            context = addStep(context, {
              reasoning: `Completion blocked by unresolved LSP bootstrap after bounded retries. ${waitMessage}`,
              state: "waiting_for_user",
              step: stepNumber,
              toolCall: null,
              toolResult: null,
            });
            return await finalizeResult({
              context,
              finalState: "waiting_for_user",
              message: waitMessage,
              success: false,
            }, stepNumber, "lsp_bootstrap_retry_limit_reached");
          }

          context = addStep(context, {
            reasoning: `Completion requested while LSP bootstrap is pending. ${bootstrapMessage}`,
            state: "executing",
            step: stepNumber,
            toolCall: null,
            toolResult: null,
          });
          memory.addMessage(
            "assistant",
            `Completion gate check result: ${failureMessage}`
          );
          logStep(stepNumber, `Completion blocked by pending LSP bootstrap: ${failureMessage}`);
          continue;
        }

        const plannerCompletionGates = parsePlannerCompletionGates(planResult.completionGateCommands);
        if (plannerCompletionGates.length > 0) {
          const mergedWithPlanner = mergeCompletionGates(completionPlan.gates, plannerCompletionGates);
          if (mergedWithPlanner.length !== completionPlan.gates.length) {
            completionPlan = {
              ...completionPlan,
              gates: mergedWithPlanner,
              source: completionPlan.gates.length === 0 ? "planner" : "merged",
            };
            memory.addMessage(
              "assistant",
              `Planner supplied completion gates: ${describeCompletionPlan(completionPlan).join(" | ")}`
            );
          }
        }

        const shouldDiscoverGates =
          lastWriteStep !== undefined &&
          (
            (strictCompletionValidation && config.completionRequireDiscoveredGates) ||
            (completionPlan.gates.length === 0 && !planResult.completionGatesDeclaredNone)
          );
        if (shouldDiscoverGates) {
          const autoDiscoveredGates = await discoverAutomaticCompletionGates(validationWorkingDirectory);
          if (autoDiscoveredGates.length > 0) {
            const mergedWithDiscovered = mergeCompletionGates(completionPlan.gates, autoDiscoveredGates);
            if (mergedWithDiscovered.length !== completionPlan.gates.length) {
              completionPlan = {
                ...completionPlan,
                gates: mergedWithDiscovered,
                source: completionPlan.gates.length === 0 ? "auto_discovered" : "merged",
              };
              memory.addMessage(
                "assistant",
                `Runtime merged discovered completion gates in ${validationWorkingDirectory}: ${describeCompletionPlan(completionPlan).join(" | ")}`
              );
            }
          }
        }

        if (strictCompletionValidation && planResult.completionGatesDeclaredNone && lastWriteStep !== undefined) {
          const failureMessage =
            "Completion blocked: `gates: none` is not allowed after file changes in strict mode. Provide validation gates and rerun.";
          lastCompletionGateFailure = failureMessage;
          await recordCompletionValidationBlocked(stepNumber, failureMessage, {
            completionValidationMode: config.completionValidationMode,
            lastWriteStep,
          });
          context = addStep(context, {
            reasoning: `Completion requested with gates:none after writes. ${failureMessage}`,
            state: "executing",
            step: stepNumber,
            toolCall: null,
            toolResult: null,
          });
          memory.addMessage("assistant", `Completion gate check result: ${failureMessage}`);
          logStep(stepNumber, failureMessage);
          continue;
        }

        if (completionPlan.gates.length === 0 && !planResult.completionGatesDeclaredNone) {
          const failureMessage =
            "No completion gates available. Provide `GATES: <command_1>;;<command_2>` with COMPLETE, use DONE_CRITERIA, or explicitly declare `GATES: none`.";
          lastCompletionGateFailure = failureMessage;
          await recordCompletionValidationBlocked(stepNumber, failureMessage, {
            completionValidationMode: config.completionValidationMode,
          });
          context = addStep(context, {
            reasoning: `Completion requested without gates. ${failureMessage}`,
            state: "executing",
            step: stepNumber,
            toolCall: null,
            toolResult: null,
          });
          memory.addMessage(
            "assistant",
            `Completion gate check result: ${failureMessage}`
          );
          logStep(stepNumber, `Completion blocked by missing gates: ${failureMessage}`);
          continue;
        }

        const maskedGate = shouldBlockForMaskedGates({
          gateDisallowMasking: config.gateDisallowMasking,
          gates: completionPlan.gates,
          strictCompletionValidation,
        });
        if (maskedGate) {
          const failureMessage =
            `Completion blocked: validation gate ${maskedGate.gate.label} appears masked (${maskedGate.reason}). ` +
            "Provide an unmasked validation command.";
          lastCompletionGateFailure = failureMessage;
          await appendRunEvent({
            event: "validation_gate_masked",
            observer,
            payload: {
              command: maskedGate.gate.command,
              gateLabel: maskedGate.gate.label,
              reason: maskedGate.reason,
            },
            phase: "finalizing",
            runId,
            sessionId,
            step: stepNumber,
          });
          await recordCompletionValidationBlocked(stepNumber, failureMessage, {
            gate: maskedGate.gate.label,
            reason: maskedGate.reason,
          });
          memory.addMessage("assistant", `Completion gate check result: ${failureMessage}`);
          context = addStep(context, {
            reasoning: failureMessage,
            state: "executing",
            step: stepNumber,
            toolCall: null,
            toolResult: null,
          });
          logStep(stepNumber, failureMessage);
          continue;
        }

        if (completionPlan.gates.length > 0) {
          let approvalBlockedMessage: null | string = null;
          for (const gate of completionPlan.gates) {
            const gateApproval = await resolveCommandApproval({
              command: gate.command,
              workingDirectory: validationWorkingDirectory,
            });

            if (gateApproval.status === "allow") {
              if (gateApproval.requiredApproval) {
                observer?.onApprovalResolved?.({
                  decision: "allow",
                  scope: gateApproval.scope,
                });
                await appendRunEvent({
                  event: "approval_resolved",
                  observer,
                  payload: {
                    command: gate.command,
                    decision: "allow",
                    scope: gateApproval.scope,
                  },
                  phase: "approval",
                  runId,
                  sessionId,
                  step: stepNumber,
                });
              }
              continue;
            }

            if (gateApproval.status === "deny") {
              observer?.onApprovalResolved?.({
                decision: "deny",
                scope: gateApproval.scope,
              });
              await appendRunEvent({
                event: "approval_resolved",
                observer,
                payload: {
                  command: gate.command,
                  decision: "deny",
                  scope: gateApproval.scope,
                },
                phase: "approval",
                runId,
                sessionId,
                step: stepNumber,
              });
              approvalBlockedMessage = gateApproval.message;
              break;
            }

            observer?.onApprovalRequested?.({
              command: gate.command,
              reason: gateApproval.reason,
              step: stepNumber,
            });
            memory.addMessage("assistant", gateApproval.message);
            context = addStep(context, {
              reasoning: `Waiting for explicit confirmation before running destructive completion gate. ${gateApproval.reason}`,
              state: "waiting_for_user",
              step: stepNumber,
              toolCall: null,
              toolResult: null,
            });
            await appendRunEvent({
              event: "approval_requested",
              observer,
              payload: {
                command: gate.command,
                commandSignature: gateApproval.commandSignature,
                reason: gateApproval.reason,
              },
              phase: "approval",
              runId,
              sessionId,
              step: stepNumber,
            });
            return await finalizeResult({
              context,
              finalState: "waiting_for_user",
              message: gateApproval.message,
              success: false,
            }, stepNumber, "destructive_completion_gate_confirmation");
          }

          if (approvalBlockedMessage) {
            const failureMessage = `Completion blocked by approval policy: ${approvalBlockedMessage}`;
            lastCompletionGateFailure = failureMessage;
            await recordCompletionValidationBlocked(stepNumber, failureMessage, {
              completionValidationMode: config.completionValidationMode,
            });
            memory.addMessage("assistant", failureMessage);
            context = addStep(context, {
              reasoning: failureMessage,
              state: "executing",
              step: stepNumber,
              toolCall: null,
              toolResult: null,
            });
            logStep(stepNumber, failureMessage);
            continue;
          }

          const gateResults = await runCompletionGates(
            completionPlan.gates,
            validationWorkingDirectory,
            (toolCall) => runToolCall(toolCall, toolExecutionContext)
          );
          const failureMessage = buildCompletionFailureMessage(gateResults);

          memory.addMessage(
            "assistant",
            `Completion gate check result: ${failureMessage}`
          );

          const hasFailure = gateResults.some((gateResult) => !gateResult.result.success);
          if (hasFailure) {
            lastCompletionGateFailure = failureMessage;
            await recordCompletionValidationBlocked(stepNumber, failureMessage, {
              completionValidationMode: config.completionValidationMode,
            });
            context = addStep(context, {
              reasoning: `Completion requested but gates failed. ${failureMessage}`,
              state: "executing",
              step: stepNumber,
              toolCall: null,
              toolResult: null,
            });
            logStep(stepNumber, `Completion blocked by gates: ${failureMessage}`);
            continue;
          }

          lastSuccessfulValidationStep = stepNumber;
        }

        if (shouldBlockForFreshness({
          lastSuccessfulValidationStep,
          lastWriteStep,
          strictCompletionValidation,
        })) {
          const failureMessage =
            "Completion blocked: validation freshness check failed. Re-run validation gates after the latest file changes.";
          lastCompletionGateFailure = failureMessage;
          await recordCompletionValidationBlocked(stepNumber, failureMessage, {
            completionValidationMode: config.completionValidationMode,
            lastSuccessfulValidationStep,
            lastWriteStep,
          });
          memory.addMessage("assistant", `Completion gate check result: ${failureMessage}`);
          context = addStep(context, {
            reasoning: failureMessage,
            state: "executing",
            step: stepNumber,
            toolCall: null,
            toolResult: null,
          });
          logStep(stepNumber, failureMessage);
          continue;
        }

        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "completed",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        lastCompletionGateFailure = null;
        return await finalizeResult({
          context,
          finalState: "completed",
          message: planResult.userMessage ?? planResult.reasoning,
          success: true,
        }, stepNumber, "planner_complete");
      }

      if (planResult.action === "blocked") {
        const blockedMessage = planResult.userMessage ?? planResult.reasoning;
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "blocked",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        return await finalizeResult({
          context,
          finalState: "blocked",
          message: blockedMessage,
          success: false,
        }, stepNumber, "planner_blocked");
      }

      if (planResult.action === "ask_user") {
        const askUserMessage = ensureUserFacingQuestion(
          planResult.userMessage ?? planResult.reasoning
        );
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "waiting_for_user",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        return await finalizeResult({
          context,
          finalState: "waiting_for_user",
          message: askUserMessage,
          success: false,
        }, stepNumber, "planner_ask_user");
      }

      // Execution phase
      if (!planResult.toolCall) {
        consecutiveNoToolContinues += 1;
        logStep(stepNumber, "No tool call specified, continuing...");
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "executing",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        if (consecutiveNoToolContinues >= MAX_CONSECUTIVE_NO_TOOL_CONTINUES) {
          const noProgressMessage =
            `Planner returned no executable tool call for ${String(consecutiveNoToolContinues)} consecutive steps. ` +
            "Please clarify the expected concrete action (file path, language, or command intent).";
          memory.addMessage("assistant", noProgressMessage);
          return await finalizeResult({
            context,
            finalState: "waiting_for_user",
            message: noProgressMessage,
            success: false,
          }, stepNumber, "no_tool_progress_guard");
        }
        continue;
      }
      consecutiveNoToolContinues = 0;
      const plannedToolCallSignature = buildToolCallSignature(
        planResult.toolCall.name,
        planResult.toolCall.arguments
      );
      const preExecutionLoopDetection = detectPreExecutionDoomLoop({
        historySignatures: toolCallSignatureHistory,
        nextSignature: plannedToolCallSignature,
        threshold: config.doomLoopThreshold,
      });
      if (preExecutionLoopDetection.shouldBlock) {
        const loopGuardReason =
          `Detected a repeated tool-call loop before execution (same call repeated ${String(preExecutionLoopDetection.repeatedCount)} times).`;
        const loopGuardMessage =
          `${loopGuardReason} ` +
          "Please clarify a different strategy or provide tighter constraints.";
        observer?.onLoopGuard?.({
          reason: loopGuardReason,
          repeatCount: preExecutionLoopDetection.repeatedCount,
          signature: plannedToolCallSignature,
          step: stepNumber,
        });
        await appendRunEvent({
          event: "loop_guard_triggered",
          observer,
          payload: {
            reason: loopGuardReason,
            repeatCount: preExecutionLoopDetection.repeatedCount,
            signature: plannedToolCallSignature,
          },
          phase: "executing",
          runId,
          sessionId,
          step: stepNumber,
        });
        memory.addMessage("assistant", loopGuardMessage);
        context = addStep(context, {
          reasoning: `Loop guard blocked repeated tool call: ${loopGuardReason}`,
          state: "waiting_for_user",
          step: stepNumber,
          toolCall: {
            arguments: planResult.toolCall.arguments,
            name: planResult.toolCall.name,
          },
          toolResult: null,
        });
        return await finalizeResult({
          context,
          finalState: "waiting_for_user",
          message: loopGuardMessage,
          success: false,
        }, stepNumber, "loop_guard_pre_execution");
      }

      const plannedExecuteCommand =
        planResult.toolCall.name === "execute_command"
          ? getExecuteCommandText(planResult.toolCall.arguments)
          : undefined;
      const plannedExecuteWorkingDirectory =
        planResult.toolCall.name === "execute_command"
          ? resolve(getExecuteCommandWorkingDirectory(planResult.toolCall.arguments) ?? process.cwd())
          : undefined;

      if (planResult.toolCall.name === "execute_command") {
        const command = plannedExecuteCommand;
        const commandWorkingDirectory = plannedExecuteWorkingDirectory;
        if (command) {
          const commandApproval = await resolveCommandApproval({
            command,
            workingDirectory: commandWorkingDirectory,
          });

          if (commandApproval.status === "allow") {
            if (commandApproval.requiredApproval) {
              observer?.onApprovalResolved?.({
                decision: "allow",
                scope: commandApproval.scope,
              });
              await appendRunEvent({
                event: "approval_resolved",
                observer,
                payload: {
                  command,
                  decision: "allow",
                  scope: commandApproval.scope,
                },
                phase: "approval",
                runId,
                sessionId,
                step: stepNumber,
              });
            }
          } else if (commandApproval.status === "deny") {
            observer?.onApprovalResolved?.({
              decision: "deny",
              scope: commandApproval.scope,
            });
            await appendRunEvent({
              event: "approval_resolved",
              observer,
              payload: {
                command,
                decision: "deny",
                scope: commandApproval.scope,
              },
              phase: "approval",
              runId,
              sessionId,
              step: stepNumber,
            });
            memory.addMessage("assistant", commandApproval.message);
            context = addStep(context, {
              reasoning: `Command execution denied by ${commandApproval.scope} approval rule.`,
              state: "executing",
              step: stepNumber,
              toolCall: {
                arguments: planResult.toolCall.arguments,
                name: planResult.toolCall.name,
              },
              toolResult: {
                error: "Command denied by approval policy",
                output: commandApproval.message,
                success: false,
              },
            });
            toolCallSignatureHistory.push(plannedToolCallSignature);
            continue;
          } else {
            observer?.onApprovalRequested?.({
              command,
              reason: commandApproval.reason,
              step: stepNumber,
            });
            memory.addMessage("assistant", commandApproval.message);
            context = addStep(context, {
              reasoning: `Waiting for explicit confirmation before running destructive command. ${commandApproval.reason}`,
              state: "waiting_for_user",
              step: stepNumber,
              toolCall: {
                arguments: planResult.toolCall.arguments,
                name: planResult.toolCall.name,
              },
              toolResult: null,
            });
            await appendRunEvent({
              event: "approval_requested",
              observer,
              payload: {
                command,
                commandSignature: commandApproval.commandSignature,
                reason: commandApproval.reason,
              },
              phase: "approval",
              runId,
              sessionId,
              step: stepNumber,
            });
            return await finalizeResult({
              context,
              finalState: "waiting_for_user",
              message: commandApproval.message,
              success: false,
            }, stepNumber, "destructive_command_confirmation");
          }
        }
      }

      context = transitionState(context, "executing");

      try {
        const toolCall = {
          arguments: planResult.toolCall.arguments,
          name: planResult.toolCall.name,
        };

        const retryConfiguration = getRetryConfiguration(toolCall, {
          maxRetries: config.transientRetryMaxAttempts,
          retryMaxDelayMs: config.transientRetryMaxDelayMs,
        });

        let attempt = 0;
        let analysis: Awaited<ReturnType<typeof analyzeToolResult>> | null = null;
        let toolResult: ToolResult = {
          error: "Tool was not executed",
          output: "",
          success: false,
        };

        while (true) {
          attempt += 1;
          if (abortSignal?.aborted) {
            return await finalizeInterrupted({
              reason: "abort_signal_pre_tool_call",
              step: stepNumber,
              toolCall,
            });
          }
          observer?.onToolCall?.({
            arguments: toolCall.arguments,
            attempt,
            name: toolCall.name,
            step: stepNumber,
          });
          await appendRunEvent({
            event: "tool_call_started",
            observer,
            payload: {
              attempt,
              signature: plannedToolCallSignature,
              toolName: toolCall.name,
            },
            phase: "executing",
            runId,
            sessionId,
            step: stepNumber,
          });
          toolResult = await runToolCall(toolCall, toolExecutionContext);
          const retryClassification = classifyRetry(toolCall, toolResult);
          toolResult = {
            ...toolResult,
            artifacts: {
              ...toolResult.artifacts,
              retryCategory: retryClassification.category,
            },
          };
          observer?.onToolResult?.({
            attempt,
            error: toolResult.error,
            name: toolCall.name,
            output: toolResult.output,
            step: stepNumber,
            success: toolResult.success,
          });
          await appendRunEvent({
            event: "tool_call_finished",
            observer,
            payload: {
              attempt,
              progressSignal: toolResult.artifacts?.progressSignal ?? "none",
              success: toolResult.success,
              toolName: toolCall.name,
            },
            phase: "executing",
            runId,
            sessionId,
            step: stepNumber,
          });
          emitDiagnosticsObserverEvent(observer, stepNumber, toolResult);

          if (toolResult.artifacts?.lifecycleEvent === "abort" || toolResult.artifacts?.aborted) {
            return await finalizeInterrupted({
              reason: "tool_call_aborted",
              step: stepNumber,
              toolCall,
              toolResult,
            });
          }

          if (plannedExecuteWorkingDirectory) {
            lastExecutionWorkingDirectory = plannedExecuteWorkingDirectory;
          }
          const changedFiles = toolResult.artifacts?.changedFiles ?? [];
          if (changedFiles.length > 0) {
            lastWriteStep = stepNumber;
            if (plannedExecuteWorkingDirectory) {
              lastWriteWorkingDirectory = plannedExecuteWorkingDirectory;
            }

            const currentErrorCount = toolResult.artifacts?.lspErrorCount;
            if (
              typeof currentErrorCount === "number" &&
              typeof lastWriteLspErrorCount === "number" &&
              currentErrorCount - lastWriteLspErrorCount >= config.writeRegressionErrorSpike
            ) {
              const regressionReason =
                `LSP error spike after write: ${String(lastWriteLspErrorCount)} -> ${String(currentErrorCount)} (+${String(currentErrorCount - lastWriteLspErrorCount)}).`;
              toolResult = {
                ...toolResult,
                artifacts: {
                  ...toolResult.artifacts,
                  writeRegressionDetected: true,
                  writeRegressionReason: regressionReason,
                },
              };
              memory.addMessage(
                "assistant",
                `[write_regression_detected] ${regressionReason} Prioritize repairing diagnostics before proceeding.`
              );
              await appendRunEvent({
                event: "write_regression_detected",
                observer,
                payload: {
                  errorCount: currentErrorCount,
                  previousErrorCount: lastWriteLspErrorCount,
                  reason: regressionReason,
                },
                phase: "executing",
                runId,
                sessionId,
                step: stepNumber,
              });
            }
            if (typeof currentErrorCount === "number") {
              lastWriteLspErrorCount = currentErrorCount;
            }
          }
          if (
            toolCall.name === "execute_command" &&
            toolResult.success &&
            typeof plannedExecuteCommand === "string" &&
            /\b(?:bun|npm|pnpm|yarn|cargo|go|python|pytest|ruff|eslint|tsc|vitest|jest)\b/iu.test(plannedExecuteCommand)
          ) {
            lastSuccessfulValidationStep = stepNumber;
          }

          if (config.lspEnabled) {
            const lspStatus = toolResult.artifacts?.lspStatus;
            if (lspStatus) {
              await appendRunEvent({
                event: "lsp_status_observed",
                observer,
                payload: {
                  reason: toolResult.artifacts?.lspStatusReason,
                  status: lspStatus,
                },
                phase: "executing",
                runId,
                sessionId,
                step: stepNumber,
              });
            }
            const lspBootstrapSignal = deriveLspBootstrapSignal(toolResult);
            const lspStatusReason = toolResult.artifacts?.lspStatusReason;
            const nonConfigChangedFiles = changedFiles
              .map((filePath) => resolve(filePath))
              .filter((filePath) => filePath !== lspServerConfigAbsolutePath);
            if (shouldTrackPendingLspFiles(lspBootstrapSignal)) {
              for (const filePath of nonConfigChangedFiles) {
                lspBootstrap.pendingChangedFiles.add(filePath);
              }
            }
            const transition = advanceLspBootstrapState({
              changedFiles: Array.from(lspBootstrap.pendingChangedFiles),
              lspServerConfigPath: config.lspServerConfigPath,
              previousReason: lspBootstrap.lastFailureReason,
              previousState: lspBootstrap.state,
              signal: lspBootstrapSignal,
              signalReason: lspStatusReason,
            });
            lspBootstrap.state = transition.state;
            lspBootstrap.lastFailureReason = transition.reason;
            if (lspBootstrapSignal === "active") {
              lspBootstrap.pendingChangedFiles.clear();
            }
            if (transition.event && transition.message) {
              memory.addMessage("assistant", transition.message);
              await appendRunEvent({
                event: transition.event,
                observer,
                payload: transition.payload ?? {},
                phase: "executing",
                runId,
                sessionId,
                step: stepNumber,
              });
            }

            const touchedLspConfig =
              changedFiles.some((filePath) => resolve(filePath) === lspServerConfigAbsolutePath) ||
              (plannedExecuteCommand?.includes(config.lspServerConfigPath) ?? false);
            if (
              touchedLspConfig &&
              lspBootstrap.pendingChangedFiles.size > 0 &&
              (lspBootstrap.state === "required" || lspBootstrap.state === "failed")
            ) {
              lspBootstrap.state = "probing";
              await appendRunEvent({
                event: "lsp_bootstrap_probe_started",
                observer,
                payload: {
                  files: Array.from(lspBootstrap.pendingChangedFiles).slice(0, 20),
                  lspServerConfigPath: config.lspServerConfigPath,
                },
                phase: "executing",
                runId,
                sessionId,
                step: stepNumber,
              });

              const probeResult = await probeLspFiles(Array.from(lspBootstrap.pendingChangedFiles));
              if (probeResult.status === "active") {
                lspBootstrap.state = "ready";
                lspBootstrap.lastFailureReason = null;
                lspBootstrap.pendingChangedFiles.clear();
                await appendRunEvent({
                  event: "lsp_bootstrap_probe_succeeded",
                  observer,
                  payload: {
                    diagnosticFiles: probeResult.diagnosticsFiles.slice(0, 20),
                  },
                  phase: "executing",
                  runId,
                  sessionId,
                  step: stepNumber,
                });
                memory.addMessage(
                  "assistant",
                  "LSP bootstrap probe succeeded after servers config update."
                );
              } else {
                const reason = probeResult.reason ?? "LSP bootstrap probe did not activate diagnostics";
                lspBootstrap.state = probeResult.status === "failed" ? "failed" : "required";
                lspBootstrap.lastFailureReason = reason;
                lspBootstrap.provisionAttempts += 1;
                if (plannedExecuteCommand) {
                  const compactCommand = plannedExecuteCommand.replace(/\s+/gu, " ").trim();
                  const preview = compactCommand.length > 220
                    ? `${compactCommand.slice(0, 220)}...`
                    : compactCommand;
                  lspBootstrap.attemptedCommands.push(preview);
                  if (lspBootstrap.attemptedCommands.length > 5) {
                    lspBootstrap.attemptedCommands.shift();
                  }
                }
                await appendRunEvent({
                  event: "lsp_bootstrap_probe_failed",
                  observer,
                  payload: {
                    reason,
                    state: lspBootstrap.state,
                  },
                  phase: "executing",
                  runId,
                  sessionId,
                  step: stepNumber,
                });
                memory.addMessage(
                  "assistant",
                  buildLspBootstrapRequirementMessage(
                    config.lspServerConfigPath,
                    Array.from(lspBootstrap.pendingChangedFiles),
                    reason
                  )
                );
              }
            }
          }

          memory.addMessage("tool", buildToolMemoryDigest({
            attempt,
            toolName: planResult.toolCall.name,
            toolResult,
          }));

          const scriptCatalogUpdate = updateScriptCatalogFromOutput(
            context.scriptCatalog,
            toolResult.output,
            stepNumber
          );
          context = updateScriptCatalog(context, scriptCatalogUpdate.catalog);
          if (scriptCatalogUpdate.notes.length > 0) {
            await syncScriptRegistry(
              context.scriptCatalog,
              (toolCall) => runToolCall(toolCall, toolExecutionContext)
            );
            memory.addMessage(
              "assistant",
              `Script registry updated with ${scriptCatalogUpdate.notes.length} marker events at ${SCRIPT_REGISTRY_PATH}.`
            );
          }

          const retriesUsed = attempt - 1;
          const retryEvaluationNeeded = !toolResult.success && retriesUsed < retryConfiguration.maxRetries;
          const shouldAnalyze =
            config.executorAnalysis === "always" ||
            (config.executorAnalysis === "on_failure" && !toolResult.success) ||
            retryEvaluationNeeded;

          analysis = shouldAnalyze
            ? await analyzeToolResult(client, toolCall, toolResult, {
                onStreamEnd: () => {
                  observer?.onExecutorStreamEnd?.({
                    toolName: toolCall.name,
                  });
                },
                onStreamStart: () => {
                  observer?.onExecutorStreamStart?.({
                    toolName: toolCall.name,
                  });
                },
                onStreamToken: (token) => {
                  observer?.onExecutorStreamToken?.({
                    token,
                    toolName: toolCall.name,
                  });
                },
                retryContext: {
                  attempt,
                  maxRetries: retryConfiguration.maxRetries,
                },
                stream: config.stream,
              })
            : null;

          if (analysis) {
            memory.addMessage("assistant", `Execution analysis: ${analysis.analysis}`);
          }

          if (toolResult.success || !retryEvaluationNeeded || !analysis?.shouldRetry) {
            break;
          }

          const retryCategory = toolResult.artifacts?.retryCategory ?? "unknown";
          if (retryCategory !== "transient") {
            const suppressedReason =
              `Retry suppressed: category=${retryCategory} classifier=${retryClassification.reason}`;
            toolResult = {
              ...toolResult,
              artifacts: {
                ...toolResult.artifacts,
                retrySuppressedReason: suppressedReason,
              },
            };
            await appendRunEvent({
              event: "retry_suppressed_non_transient",
              observer,
              payload: {
                category: retryCategory,
                reason: suppressedReason,
                toolName: toolCall.name,
              },
              phase: "executing",
              runId,
              sessionId,
              step: stepNumber,
            });
            break;
          }

          const retryDelayMs = getRetryDelayMs(
            analysis.retryDelayMs,
            retryConfiguration.retryMaxDelayMs
          );
          memory.addMessage(
            "assistant",
            `Retrying tool ${planResult.toolCall.name} after ${String(retryDelayMs)}ms (attempt ${String(attempt + 1)} of ${String(retryConfiguration.maxRetries + 1)}).`
          );
          logStep(
            stepNumber,
            `Retry scheduled for tool ${planResult.toolCall.name}: delay=${String(retryDelayMs)}ms, attempt=${String(attempt + 1)}`
          );
          await sleep(retryDelayMs);
        }

        // Record step
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "executing",
          step: stepNumber,
          toolCall: {
            arguments: planResult.toolCall.arguments,
            name: planResult.toolCall.name,
          },
          toolResult,
        });
        toolCallSignatureHistory.push(plannedToolCallSignature);

        if (lastWriteStep !== undefined && lastWriteStep < stepNumber) {
          const recentWindow = Math.max(1, Math.trunc(config.readonlyStagnationWindow));
          const recentSinceWrite = context.steps
            .filter((step) => step.step > lastWriteStep && step.toolCall && step.toolResult)
            .slice(-recentWindow);
          const hasEnough = recentSinceWrite.length >= recentWindow;
          const allReadonlyInspection = recentSinceWrite.every((step) => {
            if (step.toolCall?.name !== "execute_command") {
              return false;
            }
            const changed = step.toolResult?.artifacts?.changedFiles ?? [];
            if (changed.length > 0) {
              return false;
            }
            if (!step.toolResult?.success) {
              return false;
            }
            const commandText = getExecuteCommandText(step.toolCall.arguments) ?? "";
            return /\b(?:cat|ls|wc|head|tail|rg|grep|git\s+diff|git\s+status|stat)\b/iu.test(commandText);
          });
          const validationSinceWrite =
            typeof lastSuccessfulValidationStep === "number" ? lastSuccessfulValidationStep > lastWriteStep : false;
          if (hasEnough && allReadonlyInspection && !validationSinceWrite) {
            const message =
              "Detected read-only inspection stagnation after a write without any validation. " +
              "Run a validation gate (e.g. lint/tests/build) or switch strategy to repair errors before continuing.";
            await appendRunEvent({
              event: "readonly_stagnation_guard_triggered",
              observer,
              payload: {
                window: recentWindow,
              },
              phase: "executing",
              runId,
              sessionId,
              step: stepNumber,
            });
            memory.addMessage("assistant", `[readonly_stagnation_guard_triggered] ${message}`);
            return await finalizeResult({
              context,
              finalState: "waiting_for_user",
              message,
              success: false,
            }, stepNumber, "readonly_stagnation_guard_triggered");
          }
        }

        const loopSignature = buildToolLoopSignature({
          argumentsObject: planResult.toolCall.arguments,
          output: toolResult.output,
          success: toolResult.success,
          toolName: planResult.toolCall.name,
        });
        if (loopSignature === lastToolLoopSignature) {
          lastToolLoopSignatureCount += 1;
        } else {
          lastToolLoopSignature = loopSignature;
          lastToolLoopSignatureCount = 1;
        }

        const repetitionLimit = 3;
        const stagnation = detectStagnation({
          steps: context.steps,
          window: config.stagnationWindow,
        });
        if (lastToolLoopSignatureCount >= repetitionLimit) {
          const loopGuardReason = stagnation.isStagnant
            ? `Repeated tool outcome with stagnation: ${stagnation.reason}`
            : `Repeated tool outcome observed ${String(lastToolLoopSignatureCount)} times in a row.`;
          const repetitionMessage =
            `Stopping repeated execution loop: ${loopGuardReason} ` +
            "Please refine the request or provide additional constraints.";
          observer?.onLoopGuard?.({
            reason: loopGuardReason,
            repeatCount: lastToolLoopSignatureCount,
            signature: loopSignature,
            step: stepNumber,
          });
          await appendRunEvent({
            event: "loop_guard_triggered",
            observer,
            payload: {
              reason: loopGuardReason,
              repeatCount: lastToolLoopSignatureCount,
              signature: loopSignature,
              stagnationSignals: stagnation.signals,
            },
            phase: "executing",
            runId,
            sessionId,
            step: stepNumber,
          });
          memory.addMessage("assistant", repetitionMessage);
          return await finalizeResult({
            context,
            finalState: "waiting_for_user",
            message: repetitionMessage,
            success: false,
          }, stepNumber, "post_execution_repetition_guard");
        }

        // If tool failed and retry is suggested, log it
        if (!toolResult.success) {
          logStep(
            stepNumber,
            `Tool execution failed: ${toolResult.error ?? "Unknown error"}. Retry suggested: ${analysis ? String(analysis.shouldRetry) : "unknown"}`
          );
          // Continue to next step - planner will decide on retry or alternative approach
        }
      } catch (error) {
        logError(`Step ${stepNumber} failed`, error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const isValidationError = error instanceof AgentError && error.code === "VALIDATION_ERROR";

        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: isValidationError ? "executing" : "error",
          step: stepNumber,
          toolCall: planResult.toolCall
            ? {
                arguments: planResult.toolCall.arguments,
                name: planResult.toolCall.name,
              }
            : null,
          toolResult: {
            error: errorMessage,
            output: errorMessage,
            success: false,
          },
        });

        if (isValidationError) {
          const invalidToolName = planResult.toolCall?.name ?? "unknown_tool";
          const validationNote =
            `[tool_call_validation_failed] tool=${invalidToolName} reason=${errorMessage}`;
          memory.addMessage("assistant", validationNote);
          await appendRunEvent({
            event: "tool_call_validation_failed",
            observer,
            payload: {
              reason: errorMessage,
              toolName: invalidToolName,
            },
            phase: "executing",
            runId,
            sessionId,
            step: stepNumber,
          });
          toolCallSignatureHistory.push(plannedToolCallSignature);
          continue;
        }

        observer?.onError?.({
          message: errorMessage,
        });
      }
    }

    // Max steps reached
    const maxStepsMessage = lastCompletionGateFailure
      ? `Maximum steps (${context.maxSteps}) reached. Last completion gate failure: ${lastCompletionGateFailure}`
      : `Maximum steps (${context.maxSteps}) reached without completing the task`;

    return await finalizeResult({
      context,
      finalState: "blocked",
      message: maxStepsMessage,
      success: false,
    }, context.currentStep, "max_steps_reached");
  } catch (error) {
    logError("Agent loop failed", error);
    observer?.onError?.({
      message: error instanceof Error ? error.message : "Unknown error occurred",
    });
    return await finalizeResult({
      context,
      finalState: "error",
      message: error instanceof Error ? error.message : "Unknown error occurred",
      success: false,
    }, context.currentStep, "loop_error");
  } finally {
    try {
      await memory.flushMessageSink();
    } catch (error) {
      logError("Failed to flush message sink", error);
    }
  }
}
