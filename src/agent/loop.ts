import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { LlmClient } from "../llm/client";
import type { AgentContext, AgentState } from "../types/agent";
import type { AgentConfig } from "../types/config";
import type { ToolResult } from "../types/tool";
import type { AgentObserver } from "./observer";

import { buildSystemPrompt } from "../prompts/system";
import { allTools } from "../tools";
import { appendSessionMessage, appendSessionRunEvent, getSessionFilePath } from "../tools/session";
import { AgentError } from "../utils/errors";
import { log, logError, logStep } from "../utils/logger";
import {
  buildApprovalCommandSignature,
  buildPendingApprovalPrompt,
  createPendingApprovalAction,
  findApprovalRuleDecision,
} from "./approval";
import { maybeCompactContext } from "./compaction";
import {
  describeCompletionPlan,
  resolveCompletionPlan,
  type CompletionGate,
} from "./completion";
import {
  buildDiscoverProjectDocsCommand,
  buildReadProjectDocCommand,
  extractProjectDocFromToolOutput,
  parseDiscoveredProjectDocCandidates,
  resolveProjectDocsPolicy,
  truncateProjectDocPreview,
} from "./docs";
import { analyzeToolResult, executeToolCall } from "./executor";
import {
  buildToolLoopSignature,
} from "./guardrails";
import { Memory } from "./memory";
import { plan } from "./planner";
import { assessCommandSafety } from "./safety";
import {
  buildDiscoverScriptsCommand,
  buildRegistrySyncCommand,
  SCRIPT_REGISTRY_PATH,
  updateScriptCatalogFromOutput,
} from "./scripts";
import {
  buildToolCallSignature,
  detectPreExecutionDoomLoop,
  detectStagnation,
} from "./stability";
import { addStep, createInitialContext, transitionState, updateScriptCatalog } from "./state";

export interface AgentResult {
  success: boolean;
  finalState: AgentState;
  context: AgentContext;
  message: string;
}

export interface RunAgentLoopOptions {
  approvedCommandSignaturesOnce?: string[];
  observer?: AgentObserver;
  sessionId?: string;
}

const DISCOVER_SCRIPTS_COMMAND = buildDiscoverScriptsCommand();
const MAX_CONSECUTIVE_NO_TOOL_CONTINUES = 2;
const PROJECT_DOC_DISCOVERY_MAX_FILES = 24;
const PROJECT_DOC_LOAD_MAX_FILES = 8;
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

async function syncScriptRegistry(catalog: AgentContext["scriptCatalog"]): Promise<void> {
  await executeToolCall({
    arguments: {
      command: buildRegistrySyncCommand(catalog),
      timeout: 30_000,
    },
    name: "execute_command",
  });
}

type CompletionGateResult = {
  gate: CompletionGate;
  result: ToolResult;
};

async function runCompletionGates(gates: CompletionGate[]): Promise<CompletionGateResult[]> {
  const results: CompletionGateResult[] = [];

  for (const gate of gates) {
    let result: ToolResult;
    try {
      result = await executeToolCall({
        arguments: {
          command: gate.command,
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

function parsePlannerCompletionGates(commands: string[] | undefined): CompletionGate[] {
  if (!commands || commands.length === 0) {
    return [];
  }

  const gates: CompletionGate[] = [];
  const seenCommands = new Set<string>();

  for (const rawCommand of commands) {
    const command = rawCommand.trim();
    if (!command || seenCommands.has(command)) {
      continue;
    }

    seenCommands.add(command);
    gates.push({
      command,
      label: `planner:${gates.length + 1}`,
    });
  }

  return gates;
}

function buildCompletionFailureMessage(gateResults: CompletionGateResult[]): string {
  const failedGates = gateResults.filter((gateResult) => !gateResult.result.success);
  if (failedGates.length === 0) {
    return "All completion gates passed.";
  }

  return failedGates
    .map((gateResult) => {
      const output = gateResult.result.output.replace(/\s+/gu, " ").trim();
      const detail = output.length > 180 ? `${output.slice(0, 180)}...` : output;
      return `${gateResult.gate.label} failed (${gateResult.gate.command}): ${detail}`;
    })
    .join(" | ");
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
  maxStepRetries: number
): {
  maxRetries: number;
  retryMaxDelayMs?: number;
} {
  if (toolCall.name !== "execute_command") {
    return {
      maxRetries: maxStepRetries,
    };
  }

  const requestedMaxRetries = parseNonNegativeInteger(toolCall.arguments.maxRetries);
  const retryMaxDelayMs = parseNonNegativeInteger(toolCall.arguments.retryMaxDelayMs);

  return {
    maxRetries: requestedMaxRetries === undefined
      ? maxStepRetries
      : Math.min(requestedMaxRetries, maxStepRetries),
    retryMaxDelayMs,
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

export async function runAgentLoop(
  client: LlmClient,
  config: AgentConfig,
  task: string,
  options?: RunAgentLoopOptions
): Promise<AgentResult> {
  log(`Starting agent loop for task: ${task}`);

  const observer = options?.observer;
  const sessionId = options?.sessionId;
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
  const toolCallSignatureHistory: string[] = [];
  const onceApprovedSignatures = new Set(options?.approvedCommandSignaturesOnce ?? []);
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

    const discoveredScripts = await executeToolCall({
      arguments: {
        command: DISCOVER_SCRIPTS_COMMAND,
        timeout: 30_000,
      },
      name: "execute_command",
    });
    const discoveredCatalogUpdate = updateScriptCatalogFromOutput(
      context.scriptCatalog,
      discoveredScripts.output,
      0
    );
    context = updateScriptCatalog(context, discoveredCatalogUpdate.catalog);
    await syncScriptRegistry(context.scriptCatalog);
    if (discoveredCatalogUpdate.notes.length > 0) {
      memory.addMessage(
        "assistant",
        `Startup script discovery complete. Registered or updated ${discoveredCatalogUpdate.notes.length} scripts in ${SCRIPT_REGISTRY_PATH}.`
      );
    }
    const discoverDocsResult = await executeToolCall({
      arguments: {
        command: buildDiscoverProjectDocsCommand({
          maxFiles: PROJECT_DOC_DISCOVERY_MAX_FILES,
          platform: process.platform,
        }),
        outputLimitChars: PROJECT_DOC_OUTPUT_LIMIT_CHARS,
        timeout: PROJECT_DOC_TIMEOUT_MS,
      },
      name: "execute_command",
    });
    const discoveredDocCandidates = discoverDocsResult.success
      ? parseDiscoveredProjectDocCandidates(discoverDocsResult.output, PROJECT_DOC_DISCOVERY_MAX_FILES)
      : [];
    const docsPolicy = resolveProjectDocsPolicy(task, discoveredDocCandidates);
    if (docsPolicy.skipAllDocs) {
      memory.addMessage(
        "assistant",
        "Skipping project documentation files because the user explicitly requested to avoid docs."
      );
    } else {
      const excludedDocPaths = new Set(docsPolicy.excludedDocPaths.map((path) => path.toLowerCase()));
      const loadedDocs: Array<{ content: string; path: string }> = [];
      const candidateDocsToLoad = discoveredDocCandidates
        .filter((path) => !excludedDocPaths.has(path.toLowerCase()))
        .slice(0, PROJECT_DOC_LOAD_MAX_FILES);
      for (const docPath of candidateDocsToLoad) {
        const readDocResult = await executeToolCall({
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
        });
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

      if (excludedDocPaths.size > 0) {
        memory.addMessage(
          "assistant",
          `Skipped project docs per user request: ${Array.from(excludedDocPaths.values()).join(", ")}.`
        );
      }
      if (loadedDocs.length > 0) {
        const docsContext = loadedDocs
          .map((doc) => `### ${doc.path}\n${doc.content}`)
          .join("\n\n");
        memory.addMessage(
          "system",
          `Project documentation context (follow this unless the user overrides):\n\n${docsContext}`
        );
        const loadedCount = loadedDocs.length;
        const discoveredCount = discoveredDocCandidates.length;
        const loadNote = discoveredCount > loadedCount
          ? ` (loaded ${String(loadedCount)} of ${String(discoveredCount)} discovered)`
          : "";
        memory.addMessage(
          "assistant",
          `Loaded project documentation context from: ${loadedDocs.map((doc) => doc.path).join(", ")}${loadNote}.`
        );
      } else if (discoveredDocCandidates.length > 0) {
        memory.addMessage(
          "assistant",
          "Project docs were discovered but none were loaded after exclusions or read attempts."
        );
      } else {
        memory.addMessage(
          "assistant",
          "No project documentation files were discovered."
        );
      }
    }

    while (context.currentStep < context.maxSteps) {
      const stepNumber = context.currentStep + 1;
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
        stream: config.stream,
      });
      await appendRunEvent({
        event: "plan_parsed",
        observer,
        payload: {
          action: planResult.action,
          hasToolCall: Boolean(planResult.toolCall),
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
        const plannerCompletionGates = parsePlannerCompletionGates(planResult.completionGateCommands);
        if (completionPlan.gates.length === 0 && plannerCompletionGates.length > 0) {
          completionPlan = {
            ...completionPlan,
            gates: plannerCompletionGates,
            source: "planner",
          };
          memory.addMessage(
            "assistant",
            `Planner supplied completion gates: ${describeCompletionPlan(completionPlan).join(" | ")}`
          );
        }

        if (completionPlan.gates.length === 0 && !planResult.completionGatesDeclaredNone) {
          const failureMessage =
            "No completion gates available. Provide `GATES: <command_1>;;<command_2>` with COMPLETE, use DONE_CRITERIA, or explicitly declare `GATES: none`.";
          lastCompletionGateFailure = failureMessage;
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

        if (completionPlan.gates.length > 0) {
          let approvalBlockedMessage: null | string = null;
          for (const gate of completionPlan.gates) {
            const gateApproval = await resolveCommandApproval({
              command: gate.command,
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

          const gateResults = await runCompletionGates(completionPlan.gates);
          const failureMessage = buildCompletionFailureMessage(gateResults);

          memory.addMessage(
            "assistant",
            `Completion gate check result: ${failureMessage}`
          );

          const hasFailure = gateResults.some((gateResult) => !gateResult.result.success);
          if (hasFailure) {
            lastCompletionGateFailure = failureMessage;
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

      if (planResult.toolCall.name === "execute_command") {
        const command = getExecuteCommandText(planResult.toolCall.arguments);
        const commandWorkingDirectory = getExecuteCommandWorkingDirectory(
          planResult.toolCall.arguments
        );
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

        const maxStepRetries = Math.max(0, context.maxSteps - stepNumber);
        const retryConfiguration = getRetryConfiguration(toolCall, maxStepRetries);

        let attempt = 0;
        let analysis: Awaited<ReturnType<typeof analyzeToolResult>> | null = null;
        let toolResult: ToolResult = {
          error: "Tool was not executed",
          output: "",
          success: false,
        };

        while (true) {
          attempt += 1;
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
          toolResult = await executeToolCall(toolCall);
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

          memory.addMessage(
            "tool",
            `Tool ${planResult.toolCall.name} attempt ${String(attempt)} result: ${toolResult.output}`
          );

          const scriptCatalogUpdate = updateScriptCatalogFromOutput(
            context.scriptCatalog,
            toolResult.output,
            stepNumber
          );
          context = updateScriptCatalog(context, scriptCatalogUpdate.catalog);
          if (scriptCatalogUpdate.notes.length > 0) {
            await syncScriptRegistry(context.scriptCatalog);
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
        observer?.onError?.({
          message: errorMessage,
        });

        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "error",
          step: stepNumber,
          toolCall: planResult.toolCall
            ? {
                arguments: planResult.toolCall.arguments,
                name: planResult.toolCall.name,
              }
            : null,
          toolResult: {
            error: errorMessage,
            output: "",
            success: false,
          },
        });

        // If it's a critical error, stop
        if (error instanceof AgentError && error.code === "VALIDATION_ERROR") {
          return await finalizeResult({
            context,
            finalState: "error",
            message: `Validation error: ${errorMessage}`,
            success: false,
          }, stepNumber, "validation_error");
        }
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
