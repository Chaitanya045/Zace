import { resolve } from "node:path";

import type { LlmClient } from "../../../llm/client";
import type { PermissionMemory } from "../../../permission/memory";
import type { SessionStoreWrite } from "../../../session/store";
import type { AgentContext, AgentState } from "../../../types/agent";
import type { AgentConfig } from "../../../types/config";
import type { AbortSignalLike, ToolExecutionContext, ToolResult } from "../../../types/tool";
import type { AgentObserver } from "../../observer";
import type { PlanResult } from "../../planner/plan";
import type { AgentProcessorEvent } from "../../stream-events";
import type {
  CommandApprovalResult,
  RunLoopMutableState,
  ToolCallLike,
} from "./types";

import { createLlmStreamCallbacks } from "../../../llm/stream-adapter";
import { AgentError } from "../../../utils/errors";
import { logError, logStep } from "../../../utils/logger";
import { classifyRetry } from "../../execution/retry-classifier";
import { buildToolMemoryDigest } from "../../execution/tool-memory-digest";
import { analyzeToolResult } from "../../executor";
import { buildToolLoopSignature } from "../../guardrails";
import { SCRIPT_REGISTRY_PATH, updateScriptCatalogFromOutput } from "../../scripts";
import { buildToolCallSignature, detectPreExecutionDoomLoop } from "../../stability";
import { addStep, transitionState, updateScriptCatalog } from "../../state";
import {
  getExecuteCommandText,
  getExecuteCommandWorkingDirectory,
  isReadOnlyInspectionCommand,
  isRuntimeScriptInvocation,
  normalizeRuntimeScriptInvocation,
  requiresRuntimeScript,
} from "./command-safety";
import {
  emitDiagnosticsObserverEvent,
  handleNoToolCallProgress,
  hasPriorSuccessfulNoChangeResult,
  maybeFinalizeReadonlyStagnationGuard,
  maybeFinalizeRepetitionGuard,
} from "./execution/helpers";
import { handleLspBootstrapAfterToolExecution } from "./lsp-bootstrap-runtime";
import { getRetryConfiguration, getRetryDelayMs, sleep } from "./retry";
import { appendRunEvent } from "./run-events";
import { syncScriptRegistry } from "./startup";

const SCRIPT_PROTOCOL_BLOCK_ERROR = "Command blocked by runtime script protocol";

export type ExecutionPhaseOutcome<TResult> =
  | { kind: "continue_loop" }
  | { kind: "finalized"; result: TResult };

export async function handleExecutionPhase<TResult>(input: {
  abortSignal?: AbortSignalLike;
  client: LlmClient;
  config: AgentConfig;
  finalizeInterrupted: (input: {
    reason: string;
    step: number;
    toolCall?: null | ToolCallLike;
    toolResult?: null | ToolResult;
  }) => Promise<TResult>;
  finalizeResult: (
    result: {
      context: AgentContext;
      finalState: AgentState;
      message: string;
      success: boolean;
    },
    step: number,
    reason: string
  ) => Promise<TResult>;
  lspServerConfigAbsolutePath: string;
  memory: {
    addMessage: (
      role: "assistant" | "system" | "tool" | "user",
      content: string
    ) => void;
  };
  onProcessorEvent?: (event: AgentProcessorEvent) => void;
  observer?: AgentObserver;
  planResult: PlanResult;
  permissionMemory: PermissionMemory;
  resolveCommandApproval: (input: {
    command: string;
    workingDirectory?: string;
  }) => Promise<CommandApprovalResult>;
  runId: string;
  runToolCall: (
    toolCall: ToolCallLike,
    context?: ToolExecutionContext
  ) => Promise<ToolResult>;
  sessionId?: string;
  sessionStore?: SessionStoreWrite;
  state: RunLoopMutableState;
  stepNumber: number;
  toolExecutionContext?: ToolExecutionContext;
}): Promise<ExecutionPhaseOutcome<TResult>> {
  if (!input.planResult.toolCall) {
    return await handleNoToolCallProgress({
      finalizeResult: input.finalizeResult,
      memory: input.memory,
      planReasoning: input.planResult.reasoning,
      state: input.state,
      stepNumber: input.stepNumber,
    });
  }
  input.state.consecutiveNoToolContinues = 0;
  const plannedToolCallName = input.planResult.toolCall.name;
  let plannedToolCallArguments = input.planResult.toolCall.arguments;
  const isShellToolCall = plannedToolCallName === "execute_command" || plannedToolCallName === "bash";
  let plannedExecuteCommand =
    isShellToolCall
      ? getExecuteCommandText(plannedToolCallArguments)
      : undefined;
  const plannedExecuteWorkingDirectory =
    isShellToolCall
      ? resolve(getExecuteCommandWorkingDirectory(plannedToolCallArguments) ?? process.cwd())
      : undefined;
  if (plannedExecuteCommand && plannedExecuteWorkingDirectory) {
    const runtimeScriptNormalization = normalizeRuntimeScriptInvocation({
      command: plannedExecuteCommand,
      workingDirectory: plannedExecuteWorkingDirectory,
    });
    if (runtimeScriptNormalization.changed) {
      plannedExecuteCommand = runtimeScriptNormalization.command;
      plannedToolCallArguments = {
        ...plannedToolCallArguments,
        command: plannedExecuteCommand,
      };
      input.memory.addMessage(
        "assistant",
        `[runtime_script_invocation_normalized] Rewrote script invocation to ensure shell compatibility: ${plannedExecuteCommand}`
      );
      await appendRunEvent({
        event: "runtime_script_invocation_normalized",
        observer: input.observer,
        payload: {
          normalizedCommand: plannedExecuteCommand,
          reason: runtimeScriptNormalization.reason ?? "runtime_script_shell_normalization",
        },
        phase: "executing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
    }
  }
  const plannedToolCallSignature = buildToolCallSignature(
    plannedToolCallName,
    isShellToolCall
      ? {
          command: plannedExecuteCommand ?? "",
          cwd: plannedExecuteWorkingDirectory ?? process.cwd(),
        }
      : plannedToolCallArguments,
    {
      workingDirectory: plannedExecuteWorkingDirectory,
    }
  );
  const preExecutionLoopDetection = detectPreExecutionDoomLoop({
    historySignatures: input.state.toolCallSignatureHistory,
    nextSignature: plannedToolCallSignature,
    threshold: input.config.doomLoopThreshold,
  });
  if (preExecutionLoopDetection.shouldBlock) {
    const recoverableInspectionLoop =
      isShellToolCall &&
      typeof plannedExecuteCommand === "string" &&
      isReadOnlyInspectionCommand(plannedExecuteCommand) &&
      hasPriorSuccessfulNoChangeResult(input.state, plannedToolCallSignature) &&
      !input.state.inspectionLoopRecoverySignatures.has(plannedToolCallSignature);
    if (recoverableInspectionLoop) {
      input.state.inspectionLoopRecoverySignatures.add(plannedToolCallSignature);
      const recoveryMessage =
        "[inspection_loop_recovery] Repeated inspection command detected before execution. " +
        "Reuse the previous successful output, switch to a targeted inspect command, or proceed to write/validation instead of repeating the same inspect call.";
      input.memory.addMessage("assistant", recoveryMessage);
      await appendRunEvent({
        event: "inspection_loop_recovery_triggered",
        observer: input.observer,
        payload: {
          command: plannedExecuteCommand,
          repeatCount: preExecutionLoopDetection.repeatedCount,
          signature: plannedToolCallSignature,
        },
        phase: "executing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
      input.state.context = addStep(input.state.context, {
        reasoning:
          `Recovered from repeated inspection loop (${String(preExecutionLoopDetection.repeatedCount)} repeats) before execution. ` +
          "Prompted planner to reuse prior output and change strategy.",
        state: "executing",
        step: input.stepNumber,
        toolCall: {
          arguments: plannedToolCallArguments,
          name: plannedToolCallName,
        },
        toolResult: null,
      });
      return { kind: "continue_loop" };
    }

    const loopGuardReason =
      `Detected a repeated tool-call loop before execution (same call repeated ${String(preExecutionLoopDetection.repeatedCount)} times).`;
    const loopGuardMessage =
      `${loopGuardReason} ` +
      "Please clarify a different strategy or provide tighter constraints.";
    input.observer?.onLoopGuard?.({
      reason: loopGuardReason,
      repeatCount: preExecutionLoopDetection.repeatedCount,
      signature: plannedToolCallSignature,
      step: input.stepNumber,
    });
    await appendRunEvent({
      event: "loop_guard_triggered",
      observer: input.observer,
      payload: {
        reason: loopGuardReason,
        repeatCount: preExecutionLoopDetection.repeatedCount,
        signature: plannedToolCallSignature,
      },
      phase: "executing",
      runId: input.runId,
      sessionId: input.sessionId,
      step: input.stepNumber,
    });
    input.memory.addMessage("assistant", loopGuardMessage);
    input.state.context = addStep(input.state.context, {
      reasoning: `Loop guard blocked repeated tool call: ${loopGuardReason}`,
      state: "waiting_for_user",
      step: input.stepNumber,
      toolCall: {
        arguments: plannedToolCallArguments,
        name: plannedToolCallName,
      },
      toolResult: null,
    });
    return {
      kind: "finalized",
      result: await input.finalizeResult({
        context: input.state.context,
        finalState: "waiting_for_user",
        message: loopGuardMessage,
        success: false,
      }, input.stepNumber, "loop_guard_pre_execution"),
    };
  }

  if (isShellToolCall) {
    const command = plannedExecuteCommand;
    const commandWorkingDirectory = plannedExecuteWorkingDirectory;
    if (command) {
      const runtimeScriptEnforced = input.config.runtimeScriptEnforced ?? false;
      if (
        runtimeScriptEnforced &&
        commandWorkingDirectory &&
        requiresRuntimeScript(command) &&
        !isRuntimeScriptInvocation(command, commandWorkingDirectory)
      ) {
        const protocolMessage =
          "Runtime blocked this command: mutating or complex commands must run through reusable scripts.\n" +
          "Next steps:\n" +
          "1. Create or update a script under .zace/runtime/scripts.\n" +
          "2. Emit ZACE_SCRIPT_REGISTER|<script_id>|<script_path>|<purpose> when authoring/updating the script.\n" +
          "3. Execute the script and emit ZACE_SCRIPT_USE|<script_id>.";
        input.memory.addMessage("assistant", protocolMessage);
        await appendRunEvent({
          event: "script_protocol_blocked",
          observer: input.observer,
          payload: {
            command,
            signature: plannedToolCallSignature,
          },
          phase: "executing",
          runId: input.runId,
          sessionId: input.sessionId,
          step: input.stepNumber,
        });
        input.state.context = addStep(input.state.context, {
          reasoning:
            "Blocked direct mutating/complex shell command because runtime script protocol is enforced.",
          state: "executing",
          step: input.stepNumber,
          toolCall: {
            arguments: plannedToolCallArguments,
            name: plannedToolCallName,
          },
          toolResult: {
            error: SCRIPT_PROTOCOL_BLOCK_ERROR,
            output: protocolMessage,
            success: false,
          },
        });
        input.state.toolCallSignatureHistory.push(plannedToolCallSignature);
        return { kind: "continue_loop" };
      }

      const commandApproval = await input.resolveCommandApproval({
        command,
        workingDirectory: commandWorkingDirectory,
      });

      if (commandApproval.status === "allow") {
        if (commandApproval.requiredApproval) {
          input.observer?.onApprovalResolved?.({
            decision: "allow",
            scope: commandApproval.scope,
          });
          await appendRunEvent({
            event: "approval_resolved",
            observer: input.observer,
            payload: {
              command,
              decision: "allow",
              scope: commandApproval.scope,
            },
            phase: "approval",
            runId: input.runId,
            sessionId: input.sessionId,
            step: input.stepNumber,
          });
        }
      } else if (commandApproval.status === "deny") {
        input.observer?.onApprovalResolved?.({
          decision: "deny",
          scope: commandApproval.scope,
        });
        await appendRunEvent({
          event: "approval_resolved",
          observer: input.observer,
          payload: {
            command,
            decision: "deny",
            scope: commandApproval.scope,
          },
          phase: "approval",
          runId: input.runId,
          sessionId: input.sessionId,
          step: input.stepNumber,
        });
        input.memory.addMessage("assistant", commandApproval.message);
        input.state.context = addStep(input.state.context, {
          reasoning: `Command execution denied by ${commandApproval.scope} approval rule.`,
          state: "executing",
          step: input.stepNumber,
          toolCall: {
            arguments: plannedToolCallArguments,
            name: plannedToolCallName,
          },
          toolResult: {
            error: "Command denied by approval policy",
            output: commandApproval.message,
            success: false,
          },
        });
        input.state.toolCallSignatureHistory.push(plannedToolCallSignature);
        return { kind: "continue_loop" };
      } else {
        input.observer?.onApprovalRequested?.({
          command,
          reason: commandApproval.reason,
          step: input.stepNumber,
        });
        input.memory.addMessage("assistant", commandApproval.message);
        input.state.context = addStep(input.state.context, {
          reasoning: `Waiting for explicit confirmation before running destructive command. ${commandApproval.reason}`,
          state: "waiting_for_user",
          step: input.stepNumber,
          toolCall: {
            arguments: plannedToolCallArguments,
            name: plannedToolCallName,
          },
          toolResult: null,
        });
        await appendRunEvent({
          event: "approval_requested",
          observer: input.observer,
          payload: {
            command,
            commandSignature: commandApproval.commandSignature,
            reason: commandApproval.reason,
          },
          phase: "approval",
          runId: input.runId,
          sessionId: input.sessionId,
          step: input.stepNumber,
        });
        return {
          kind: "finalized",
          result: await input.finalizeResult({
            context: input.state.context,
            finalState: "waiting_for_user",
            message: commandApproval.message,
            success: false,
          }, input.stepNumber, "destructive_command_confirmation"),
        };
      }
    }
  }

  if (!isShellToolCall) {
    try {
      const { requirePermission } = await import("../../../permission/guard");
      await requirePermission({
        config: input.config,
        memory: input.permissionMemory,
        patterns: [plannedToolCallName],
        permission: plannedToolCallName,
        runId: input.runId,
        sessionId: input.sessionId,
      });
    } catch (error) {
      const { PermissionNext } = await import("../../../permission/next");
      if (error instanceof PermissionNext.AskedError) {
        input.memory.addMessage("assistant", error.prompt);
        input.state.context = addStep(input.state.context, {
          reasoning: `Waiting for permission to call tool: ${plannedToolCallName}`,
          state: "waiting_for_user",
          step: input.stepNumber,
          toolCall: {
            arguments: plannedToolCallArguments,
            name: plannedToolCallName,
          },
          toolResult: null,
        });
        await appendRunEvent({
          event: "permission_requested",
          observer: input.observer,
          payload: {
            patterns: [plannedToolCallName],
            permission: plannedToolCallName,
            toolName: plannedToolCallName,
          },
          phase: "approval",
          runId: input.runId,
          sessionId: input.sessionId,
          step: input.stepNumber,
        });
        return {
          kind: "finalized",
          result: await input.finalizeResult({
            context: input.state.context,
            finalState: "waiting_for_user",
            message: error.prompt,
            success: false,
          }, input.stepNumber, "permission_requested"),
        };
      }

      if (error instanceof PermissionNext.DeniedError) {
        const message = `Tool call denied by configured permission rules: ${error.message}`;
        input.memory.addMessage("assistant", message);
        input.state.context = addStep(input.state.context, {
          reasoning: `Permission rules denied tool: ${plannedToolCallName}`,
          state: "waiting_for_user",
          step: input.stepNumber,
          toolCall: {
            arguments: plannedToolCallArguments,
            name: plannedToolCallName,
          },
          toolResult: {
            error: "Tool denied by permission policy",
            output: message,
            success: false,
          },
        });
        await appendRunEvent({
          event: "permission_denied",
          observer: input.observer,
          payload: {
            permission: plannedToolCallName,
            toolName: plannedToolCallName,
          },
          phase: "approval",
          runId: input.runId,
          sessionId: input.sessionId,
          step: input.stepNumber,
        });
        return {
          kind: "finalized",
          result: await input.finalizeResult({
            context: input.state.context,
            finalState: "waiting_for_user",
            message,
            success: false,
          }, input.stepNumber, "permission_denied"),
        };
      }

      if (error instanceof PermissionNext.RejectedError) {
        const message = `Permission rejected for tool: ${plannedToolCallName}.`;
        input.memory.addMessage("assistant", message);
        input.state.context = addStep(input.state.context, {
          reasoning: `Permission rejected for tool: ${plannedToolCallName}`,
          state: "waiting_for_user",
          step: input.stepNumber,
          toolCall: {
            arguments: plannedToolCallArguments,
            name: plannedToolCallName,
          },
          toolResult: {
            error: "Permission rejected",
            output: message,
            success: false,
          },
        });
        await appendRunEvent({
          event: "permission_rejected",
          observer: input.observer,
          payload: {
            permission: plannedToolCallName,
            toolName: plannedToolCallName,
          },
          phase: "approval",
          runId: input.runId,
          sessionId: input.sessionId,
          step: input.stepNumber,
        });
        return {
          kind: "finalized",
          result: await input.finalizeResult({
            context: input.state.context,
            finalState: "waiting_for_user",
            message,
            success: false,
          }, input.stepNumber, "permission_rejected"),
        };
      }

      throw error;
    }
  }

  input.state.context = transitionState(input.state.context, "executing");

  try {
    const toolCall = {
      arguments: plannedToolCallArguments,
      name: plannedToolCallName,
    };

    const retryConfiguration = getRetryConfiguration(toolCall, {
      maxRetries: input.config.transientRetryMaxAttempts,
      retryMaxDelayMs: input.config.transientRetryMaxDelayMs,
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
      if (input.abortSignal?.aborted) {
        return {
          kind: "finalized",
          result: await input.finalizeInterrupted({
            reason: "abort_signal_pre_tool_call",
            step: input.stepNumber,
            toolCall,
          }),
        };
      }
      input.observer?.onToolCall?.({
        arguments: toolCall.arguments,
        attempt,
        name: toolCall.name,
        step: input.stepNumber,
      });
      await appendRunEvent({
        event: "tool_call_started",
        observer: input.observer,
        payload: {
          attempt,
          signature: plannedToolCallSignature,
          toolName: toolCall.name,
        },
        phase: "executing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
      toolResult = await input.runToolCall(toolCall, input.toolExecutionContext);
      const retryClassification = classifyRetry(toolCall, toolResult);
      toolResult = {
        ...toolResult,
        artifacts: {
          ...toolResult.artifacts,
          retryCategory: retryClassification.category,
        },
      };
      input.observer?.onToolResult?.({
        attempt,
        error: toolResult.error,
        name: toolCall.name,
        output: toolResult.output,
        step: input.stepNumber,
        success: toolResult.success,
      });
      await appendRunEvent({
        event: "tool_call_finished",
        observer: input.observer,
        payload: {
          attempt,
          progressSignal: toolResult.artifacts?.progressSignal ?? "none",
          success: toolResult.success,
          toolName: toolCall.name,
        },
        phase: "executing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
      emitDiagnosticsObserverEvent(input.observer, input.stepNumber, toolResult);

      if (toolResult.artifacts?.lifecycleEvent === "abort" || toolResult.artifacts?.aborted) {
        return {
          kind: "finalized",
          result: await input.finalizeInterrupted({
            reason: "tool_call_aborted",
            step: input.stepNumber,
            toolCall,
            toolResult,
          }),
        };
      }

      if (plannedExecuteWorkingDirectory) {
        input.state.lastExecutionWorkingDirectory = plannedExecuteWorkingDirectory;
      }
      const changedFiles = toolResult.artifacts?.changedFiles ?? [];
      if (changedFiles.length > 0) {
        input.state.lastWriteStep = input.stepNumber;
        if (plannedExecuteWorkingDirectory) {
          input.state.lastWriteWorkingDirectory = plannedExecuteWorkingDirectory;
        }

        const currentErrorCount = toolResult.artifacts?.lspErrorCount;
        if (
          typeof currentErrorCount === "number" &&
          typeof input.state.lastWriteLspErrorCount === "number" &&
          currentErrorCount - input.state.lastWriteLspErrorCount >= input.config.writeRegressionErrorSpike
        ) {
          const regressionReason =
            `LSP error spike after write: ${String(input.state.lastWriteLspErrorCount)} -> ${String(currentErrorCount)} (+${String(currentErrorCount - input.state.lastWriteLspErrorCount)}).`;
          toolResult = {
            ...toolResult,
            artifacts: {
              ...toolResult.artifacts,
              writeRegressionDetected: true,
              writeRegressionReason: regressionReason,
            },
          };
          input.memory.addMessage(
            "assistant",
            `[write_regression_detected] ${regressionReason} Prioritize repairing diagnostics before proceeding.`
          );
          await appendRunEvent({
            event: "write_regression_detected",
            observer: input.observer,
            payload: {
              errorCount: currentErrorCount,
              previousErrorCount: input.state.lastWriteLspErrorCount,
              reason: regressionReason,
            },
            phase: "executing",
            runId: input.runId,
            sessionId: input.sessionId,
            step: input.stepNumber,
          });
        }
        if (typeof currentErrorCount === "number") {
          input.state.lastWriteLspErrorCount = currentErrorCount;
        }
      }
      if (
        isShellToolCall &&
        toolResult.success &&
        typeof plannedExecuteCommand === "string" &&
        /\b(?:bun|npm|pnpm|yarn|cargo|go|python|pytest|ruff|eslint|tsc|vitest|jest)\b/iu.test(
          plannedExecuteCommand
        )
      ) {
        input.state.lastSuccessfulValidationStep = input.stepNumber;
      }

      if (input.config.lspEnabled) {
        await handleLspBootstrapAfterToolExecution({
          changedFiles,
          config: input.config,
          lspBootstrap: input.state.lspBootstrap,
          lspServerConfigAbsolutePath: input.lspServerConfigAbsolutePath,
          memory: {
            addMessage: (role, content) => {
              input.memory.addMessage(role, content);
            },
          },
          observer: input.observer,
          plannedExecuteCommand,
          resolveCommandApproval: input.resolveCommandApproval,
          runId: input.runId,
          runToolCall: input.runToolCall,
          sessionId: input.sessionId,
          stepNumber: input.stepNumber,
          toolExecutionContext: input.toolExecutionContext,
          toolResult,
          workingDirectory: plannedExecuteWorkingDirectory,
        });
      }

      input.memory.addMessage("tool", buildToolMemoryDigest({
        attempt,
        toolName: plannedToolCallName,
        toolResult,
      }));

      const scriptCatalogUpdate = updateScriptCatalogFromOutput(
        input.state.context.scriptCatalog,
        toolResult.output,
        input.stepNumber
      );
      input.state.context = updateScriptCatalog(input.state.context, scriptCatalogUpdate.catalog);
      if (scriptCatalogUpdate.notes.length > 0) {
        await syncScriptRegistry(
          input.state.context.scriptCatalog,
          (toolCallForSync) => input.runToolCall(toolCallForSync, input.toolExecutionContext)
        );
        input.memory.addMessage(
          "assistant",
          `Script registry updated with ${scriptCatalogUpdate.notes.length} marker events at ${SCRIPT_REGISTRY_PATH}.`
        );
      }

      const retriesUsed = attempt - 1;
      const retryEvaluationNeeded = !toolResult.success && retriesUsed < retryConfiguration.maxRetries;
      const shouldAnalyze =
        input.config.executorAnalysis === "always" ||
        (input.config.executorAnalysis === "on_failure" && !toolResult.success) ||
        retryEvaluationNeeded;

      analysis = shouldAnalyze
        ? await analyzeToolResult(input.client, toolCall, toolResult, {
            ...createLlmStreamCallbacks({
              callKind: "executor",
              emit: input.onProcessorEvent,
              onStreamEnd: () => {
                input.observer?.onExecutorStreamEnd?.({
                  toolName: toolCall.name,
                });
              },
              onStreamStart: () => {
                input.observer?.onExecutorStreamStart?.({
                  toolName: toolCall.name,
                });
              },
              onStreamToken: (token) => {
                input.observer?.onExecutorStreamToken?.({
                  token,
                  toolName: toolCall.name,
                });
              },
              phase: "executing",
              runId: input.runId,
              sessionStore: input.sessionStore,
              step: input.stepNumber,
              toolName: toolCall.name,
            }),
            retryContext: {
              attempt,
              maxRetries: retryConfiguration.maxRetries,
            },
            stream: input.config.stream,
          })
        : null;

      if (analysis) {
        input.memory.addMessage("assistant", `Execution analysis: ${analysis.analysis}`);
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
          observer: input.observer,
          payload: {
            category: retryCategory,
            reason: suppressedReason,
            toolName: toolCall.name,
          },
          phase: "executing",
          runId: input.runId,
          sessionId: input.sessionId,
          step: input.stepNumber,
        });
        break;
      }

      const retryDelayMs = getRetryDelayMs(
        analysis.retryDelayMs,
        retryConfiguration.retryMaxDelayMs
      );
      input.memory.addMessage(
        "assistant",
        `Retrying tool ${plannedToolCallName} after ${String(retryDelayMs)}ms (attempt ${String(attempt + 1)} of ${String(retryConfiguration.maxRetries + 1)}).`
      );
      logStep(
        input.stepNumber,
        `Retry scheduled for tool ${plannedToolCallName}: delay=${String(retryDelayMs)}ms, attempt=${String(attempt + 1)}`
      );
      await sleep(retryDelayMs);
    }

    // Record step
    input.state.context = addStep(input.state.context, {
      reasoning: input.planResult.reasoning,
      state: "executing",
      step: input.stepNumber,
      toolCall: {
        arguments: plannedToolCallArguments,
        name: plannedToolCallName,
      },
      toolResult,
    });
    input.state.toolCallSignatureHistory.push(plannedToolCallSignature);

    const readonlyStagnationOutcome = await maybeFinalizeReadonlyStagnationGuard({
      config: input.config,
      finalizeResult: input.finalizeResult,
      memory: input.memory,
      observer: input.observer,
      runId: input.runId,
      sessionId: input.sessionId,
      state: input.state,
      stepNumber: input.stepNumber,
    });
    if (readonlyStagnationOutcome) {
      return readonlyStagnationOutcome;
    }

    const loopSignature = buildToolLoopSignature({
      argumentsObject: plannedToolCallArguments,
      output: toolResult.output,
      success: toolResult.success,
      toolName: plannedToolCallName,
    });
    const repetitionGuardOutcome = await maybeFinalizeRepetitionGuard({
      finalizeResult: input.finalizeResult,
      loopSignature,
      memory: input.memory,
      observer: input.observer,
      runId: input.runId,
      sessionId: input.sessionId,
      stagnationWindow: input.config.stagnationWindow,
      state: input.state,
      stepNumber: input.stepNumber,
    });
    if (repetitionGuardOutcome) {
      return repetitionGuardOutcome;
    }

    if (!toolResult.success) {
      logStep(
        input.stepNumber,
        `Tool execution failed: ${toolResult.error ?? "Unknown error"}. Retry suggested: ${analysis ? String(analysis.shouldRetry) : "unknown"}`
      );
    }
  } catch (error) {
    logError(`Step ${input.stepNumber} failed`, error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const isValidationError = error instanceof AgentError && error.code === "VALIDATION_ERROR";

    input.state.context = addStep(input.state.context, {
      reasoning: input.planResult.reasoning,
      state: isValidationError ? "executing" : "error",
      step: input.stepNumber,
      toolCall: {
        arguments: plannedToolCallArguments,
        name: plannedToolCallName,
      },
      toolResult: {
        error: errorMessage,
        output: errorMessage,
        success: false,
      },
    });

    if (isValidationError) {
      const invalidToolName = plannedToolCallName || "unknown_tool";
      const validationNote =
        `[tool_call_validation_failed] tool=${invalidToolName} reason=${errorMessage}`;
      input.memory.addMessage("assistant", validationNote);
      await appendRunEvent({
        event: "tool_call_validation_failed",
        observer: input.observer,
        payload: {
          reason: errorMessage,
          toolName: invalidToolName,
        },
        phase: "executing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
      input.state.toolCallSignatureHistory.push(plannedToolCallSignature);
      return { kind: "continue_loop" };
    }

    input.observer?.onError?.({
      message: errorMessage,
    });
  }

  return { kind: "continue_loop" };
}
