import { resolve } from "node:path";

import type { LlmClient } from "../../../llm/client";
import type { AgentContext, AgentState } from "../../../types/agent";
import type { AgentConfig } from "../../../types/config";
import type { AbortSignalLike, ToolExecutionContext, ToolResult } from "../../../types/tool";
import type { AgentObserver } from "../../observer";
import type { PlanResult } from "../../planner/plan";
import type {
  CommandApprovalResult,
  RunLoopMutableState,
  ToolCallLike,
} from "./types";

import { AgentError } from "../../../utils/errors";
import { logError, logStep } from "../../../utils/logger";
import { classifyRetry } from "../../execution/retry-classifier";
import { buildToolMemoryDigest } from "../../execution/tool-memory-digest";
import { analyzeToolResult } from "../../executor";
import { buildToolLoopSignature } from "../../guardrails";
import { SCRIPT_REGISTRY_PATH, updateScriptCatalogFromOutput } from "../../scripts";
import { buildToolCallSignature, detectPreExecutionDoomLoop, detectStagnation } from "../../stability";
import { addStep, transitionState, updateScriptCatalog } from "../../state";
import {
  getExecuteCommandText,
  getExecuteCommandWorkingDirectory,
} from "./command-safety";
import { handleLspBootstrapAfterToolExecution } from "./lsp-bootstrap-runtime";
import { getRetryConfiguration, getRetryDelayMs, sleep } from "./retry";
import { appendRunEvent } from "./run-events";
import { syncScriptRegistry } from "./startup";

const MAX_CONSECUTIVE_NO_TOOL_CONTINUES = 2;

export type ExecutionPhaseOutcome<TResult> =
  | { kind: "continue_loop" }
  | { kind: "finalized"; result: TResult };

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
  observer?: AgentObserver;
  planResult: PlanResult;
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
  state: RunLoopMutableState;
  stepNumber: number;
  toolExecutionContext?: ToolExecutionContext;
}): Promise<ExecutionPhaseOutcome<TResult>> {
  if (!input.planResult.toolCall) {
    input.state.consecutiveNoToolContinues += 1;
    logStep(input.stepNumber, "No tool call specified, continuing...");
    input.state.context = addStep(input.state.context, {
      reasoning: input.planResult.reasoning,
      state: "executing",
      step: input.stepNumber,
      toolCall: null,
      toolResult: null,
    });
    if (input.state.consecutiveNoToolContinues >= MAX_CONSECUTIVE_NO_TOOL_CONTINUES) {
      const noProgressMessage =
        `Planner returned no executable tool call for ${String(input.state.consecutiveNoToolContinues)} consecutive steps. ` +
        "Please clarify the expected concrete action (file path, language, or command intent).";
      input.memory.addMessage("assistant", noProgressMessage);
      return {
        kind: "finalized",
        result: await input.finalizeResult({
          context: input.state.context,
          finalState: "waiting_for_user",
          message: noProgressMessage,
          success: false,
        }, input.stepNumber, "no_tool_progress_guard"),
      };
    }
    return { kind: "continue_loop" };
  }
  input.state.consecutiveNoToolContinues = 0;
  const plannedToolCallSignature = buildToolCallSignature(
    input.planResult.toolCall.name,
    input.planResult.toolCall.arguments
  );
  const preExecutionLoopDetection = detectPreExecutionDoomLoop({
    historySignatures: input.state.toolCallSignatureHistory,
    nextSignature: plannedToolCallSignature,
    threshold: input.config.doomLoopThreshold,
  });
  if (preExecutionLoopDetection.shouldBlock) {
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
        arguments: input.planResult.toolCall.arguments,
        name: input.planResult.toolCall.name,
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

  const plannedExecuteCommand =
    input.planResult.toolCall.name === "execute_command"
      ? getExecuteCommandText(input.planResult.toolCall.arguments)
      : undefined;
  const plannedExecuteWorkingDirectory =
    input.planResult.toolCall.name === "execute_command"
      ? resolve(getExecuteCommandWorkingDirectory(input.planResult.toolCall.arguments) ?? process.cwd())
      : undefined;

  if (input.planResult.toolCall.name === "execute_command") {
    const command = plannedExecuteCommand;
    const commandWorkingDirectory = plannedExecuteWorkingDirectory;
    if (command) {
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
            arguments: input.planResult.toolCall.arguments,
            name: input.planResult.toolCall.name,
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
            arguments: input.planResult.toolCall.arguments,
            name: input.planResult.toolCall.name,
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

  input.state.context = transitionState(input.state.context, "executing");

  try {
    const toolCall = {
      arguments: input.planResult.toolCall.arguments,
      name: input.planResult.toolCall.name,
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
        toolCall.name === "execute_command" &&
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
          runId: input.runId,
          sessionId: input.sessionId,
          stepNumber: input.stepNumber,
          toolResult,
        });
      }

      input.memory.addMessage("tool", buildToolMemoryDigest({
        attempt,
        toolName: input.planResult.toolCall.name,
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
        `Retrying tool ${input.planResult.toolCall.name} after ${String(retryDelayMs)}ms (attempt ${String(attempt + 1)} of ${String(retryConfiguration.maxRetries + 1)}).`
      );
      logStep(
        input.stepNumber,
        `Retry scheduled for tool ${input.planResult.toolCall.name}: delay=${String(retryDelayMs)}ms, attempt=${String(attempt + 1)}`
      );
      await sleep(retryDelayMs);
    }

    // Record step
    input.state.context = addStep(input.state.context, {
      reasoning: input.planResult.reasoning,
      state: "executing",
      step: input.stepNumber,
      toolCall: {
        arguments: input.planResult.toolCall.arguments,
        name: input.planResult.toolCall.name,
      },
      toolResult,
    });
    input.state.toolCallSignatureHistory.push(plannedToolCallSignature);

    if (input.state.lastWriteStep !== undefined && input.state.lastWriteStep < input.stepNumber) {
      const recentWindow = Math.max(1, Math.trunc(input.config.readonlyStagnationWindow));
      const recentSinceWrite = input.state.context.steps
        .filter((step) => step.step > input.state.lastWriteStep! && step.toolCall && step.toolResult)
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
        typeof input.state.lastSuccessfulValidationStep === "number"
          ? input.state.lastSuccessfulValidationStep > input.state.lastWriteStep
          : false;
      if (hasEnough && allReadonlyInspection && !validationSinceWrite) {
        const message =
          "Detected read-only inspection stagnation after a write without any validation. " +
          "Run a validation gate (e.g. lint/tests/build) or switch strategy to repair errors before continuing.";
        await appendRunEvent({
          event: "readonly_stagnation_guard_triggered",
          observer: input.observer,
          payload: {
            window: recentWindow,
          },
          phase: "executing",
          runId: input.runId,
          sessionId: input.sessionId,
          step: input.stepNumber,
        });
        input.memory.addMessage("assistant", `[readonly_stagnation_guard_triggered] ${message}`);
        return {
          kind: "finalized",
          result: await input.finalizeResult({
            context: input.state.context,
            finalState: "waiting_for_user",
            message,
            success: false,
          }, input.stepNumber, "readonly_stagnation_guard_triggered"),
        };
      }
    }

    const loopSignature = buildToolLoopSignature({
      argumentsObject: input.planResult.toolCall.arguments,
      output: toolResult.output,
      success: toolResult.success,
      toolName: input.planResult.toolCall.name,
    });
    if (loopSignature === input.state.lastToolLoopSignature) {
      input.state.lastToolLoopSignatureCount += 1;
    } else {
      input.state.lastToolLoopSignature = loopSignature;
      input.state.lastToolLoopSignatureCount = 1;
    }

    const repetitionLimit = 3;
    const stagnation = detectStagnation({
      steps: input.state.context.steps,
      window: input.config.stagnationWindow,
    });
    if (input.state.lastToolLoopSignatureCount >= repetitionLimit) {
      const loopGuardReason = stagnation.isStagnant
        ? `Repeated tool outcome with stagnation: ${stagnation.reason}`
        : `Repeated tool outcome observed ${String(input.state.lastToolLoopSignatureCount)} times in a row.`;
      const repetitionMessage =
        `Stopping repeated execution loop: ${loopGuardReason} ` +
        "Please refine the request or provide additional constraints.";
      input.observer?.onLoopGuard?.({
        reason: loopGuardReason,
        repeatCount: input.state.lastToolLoopSignatureCount,
        signature: loopSignature,
        step: input.stepNumber,
      });
      await appendRunEvent({
        event: "loop_guard_triggered",
        observer: input.observer,
        payload: {
          reason: loopGuardReason,
          repeatCount: input.state.lastToolLoopSignatureCount,
          signature: loopSignature,
          stagnationSignals: stagnation.signals,
        },
        phase: "executing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
      input.memory.addMessage("assistant", repetitionMessage);
      return {
        kind: "finalized",
        result: await input.finalizeResult({
          context: input.state.context,
          finalState: "waiting_for_user",
          message: repetitionMessage,
          success: false,
        }, input.stepNumber, "post_execution_repetition_guard"),
      };
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
      toolCall: input.planResult.toolCall
        ? {
            arguments: input.planResult.toolCall.arguments,
            name: input.planResult.toolCall.name,
          }
        : null,
      toolResult: {
        error: errorMessage,
        output: errorMessage,
        success: false,
      },
    });

    if (isValidationError) {
      const invalidToolName = input.planResult.toolCall?.name ?? "unknown_tool";
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
