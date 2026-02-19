import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { LlmClient } from "../../llm/client";
import type { AgentContext, AgentState } from "../../types/agent";
import type { AgentConfig } from "../../types/config";
import type { AbortSignalLike, ToolExecutionContext, ToolResult } from "../../types/tool";
import type { AgentObserver } from "../observer";
import type { CommandApprovalResult, RunLoopMutableState, ToolCallLike } from "./run-loop/types";

import { buildSystemPrompt } from "../../prompts/system";
import { allTools } from "../../tools";
import { appendSessionMessage, getSessionFilePath } from "../../tools/session";
import { log, logError, logStep } from "../../utils/logger";
import {
  buildApprovalCommandSignature,
  buildPendingApprovalPrompt,
  createPendingApprovalAction,
  findApprovalRuleDecision,
} from "../approval";
import { maybeCompactContext } from "../compaction";
import { describeCompletionPlan, resolveCompletionPlan } from "../completion";
import { executeToolCall } from "../executor";
import { Memory } from "../memory";
import { plan } from "../planner";
import { addStep, createInitialContext, transitionState } from "../state";
import { getDestructiveCommandReason } from "./run-loop/command-safety";
import { handleCompletionPhase } from "./run-loop/completion-phase";
import { handleExecutionPhase } from "./run-loop/execution-phase";
import { emitPlannerTelemetry } from "./run-loop/planner-telemetry";
import { appendRunEvent } from "./run-loop/run-events";
import { runStartupPhase } from "./run-loop/startup";

export { extractOverwriteRedirectTargets } from "./run-loop/command-safety";

export interface AgentResult {
  context: AgentContext;
  finalState: AgentState;
  message: string;
  success: boolean;
}

export interface RunAgentLoopOptions {
  abortSignal?: AbortSignalLike;
  approvedCommandSignaturesOnce?: string[];
  executeToolCall?: (
    toolCall: {
      arguments: Record<string, unknown>;
      name: string;
    },
    context?: ToolExecutionContext
  ) => Promise<ToolResult>;
  observer?: AgentObserver;
  sessionId?: string;
}

type CompletionValidationBlockedRecord = {
  blockLoopGuardTriggered: boolean;
  repeatCount: number;
  repeatLimit: number;
};

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
  const abortSignal = options?.abortSignal;
  const toolExecutionContext: ToolExecutionContext | undefined = abortSignal
    ? { abortSignal }
    : undefined;
  const runId = randomUUID();
  const sessionFilePath = sessionId ? getSessionFilePath(sessionId) : undefined;
  const completionBlockRepeatLimit = Math.max(1, config.completionBlockRepeatLimit ?? 2);
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
  const loopState: RunLoopMutableState = {
    completionBlockedReason: null,
    completionBlockedReasonRepeatCount: 0,
    completionPlan: resolveCompletionPlan(task),
    consecutiveNoToolContinues: 0,
    context: createInitialContext(task, config.maxSteps),
    lastCompletionGateFailure: null,
    lastExecutionWorkingDirectory: process.cwd(),
    lastSuccessfulValidationStep: undefined,
    lastToolLoopSignature: "",
    lastToolLoopSignatureCount: 0,
    lastWriteLspErrorCount: undefined,
    lastWriteStep: undefined,
    lastWriteWorkingDirectory: undefined,
    lspBootstrap: {
      attemptedCommands: [],
      lastFailureReason: null,
      pendingChangedFiles: new Set<string>(),
      provisionAttempts: 0,
      state: "idle",
    },
    toolCallSignatureHistory: [],
  };
  const lspServerConfigAbsolutePath = resolve(config.lspServerConfigPath);
  const onceApprovedSignatures = new Set(options?.approvedCommandSignaturesOnce ?? []);
  const runToolCall = options?.executeToolCall ?? executeToolCall;
  const getCompletionCriteria = (): string[] => describeCompletionPlan(loopState.completionPlan);
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
    reason: string;
    step: number;
    toolCall?: null | ToolCallLike;
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
    loopState.context = addStep(loopState.context, {
      reasoning: `Interrupted: ${input.reason}`,
      state: "interrupted",
      step: input.step,
      toolCall: input.toolCall ?? null,
      toolResult: input.toolResult ?? null,
    });
    return await finalizeResult({
      context: loopState.context,
      finalState: "interrupted",
      message,
      success: false,
    }, input.step, input.reason);
  };
  const recordCompletionValidationBlocked = async (
    step: number,
    reason: string,
    extraPayload?: Record<string, unknown>
  ): Promise<CompletionValidationBlockedRecord> => {
    if (loopState.completionBlockedReason === reason) {
      loopState.completionBlockedReasonRepeatCount += 1;
    } else {
      loopState.completionBlockedReason = reason;
      loopState.completionBlockedReasonRepeatCount = 1;
    }

    const repeatCount = loopState.completionBlockedReasonRepeatCount;
    const blockLoopGuardTriggered = repeatCount >= completionBlockRepeatLimit;

    await appendRunEvent({
      event: "completion_validation_blocked",
      observer,
      payload: {
        blockLoopGuardTriggered,
        reason,
        repeatCount,
        repeatLimit: completionBlockRepeatLimit,
        ...extraPayload,
      },
      phase: "finalizing",
      runId,
      sessionId,
      step,
    });
    if (blockLoopGuardTriggered) {
      await appendRunEvent({
        event: "completion_block_loop_guard_triggered",
        observer,
        payload: {
          reason,
          repeatCount,
          repeatLimit: completionBlockRepeatLimit,
        },
        phase: "finalizing",
        runId,
        sessionId,
        step,
      });
    }

    return {
      blockLoopGuardTriggered,
      repeatCount,
      repeatLimit: completionBlockRepeatLimit,
    };
  };
  const resetCompletionBlockLoopGuard = (): void => {
    loopState.completionBlockedReason = null;
    loopState.completionBlockedReasonRepeatCount = 0;
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

    const startupResult = await runStartupPhase<AgentResult>({
      config,
      context: loopState.context,
      finalizeInterrupted,
      memory,
      observer,
      runId,
      runToolCall,
      sessionId,
      task,
      toolExecutionContext,
    });
    if (startupResult.finalizedResult) {
      return startupResult.finalizedResult;
    }
    loopState.context = startupResult.context;

    while (loopState.context.currentStep < loopState.context.maxSteps) {
      const stepNumber = loopState.context.currentStep + 1;
      if (abortSignal?.aborted) {
        return await finalizeInterrupted({
          reason: "abort_signal_pre_step",
          step: stepNumber,
        });
      }
      logStep(stepNumber, `Starting step ${stepNumber}/${loopState.context.maxSteps}`);
      observer?.onStepStart?.({
        maxSteps: loopState.context.maxSteps,
        step: stepNumber,
      });

      loopState.context = transitionState(loopState.context, "planning");
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
      const planResult = await plan(client, loopState.context, memory, {
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
      await emitPlannerTelemetry({
        config,
        observer,
        planResult,
        runId,
        sessionId,
        stepNumber,
      });

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

      const completionOutcome = await handleCompletionPhase<AgentResult>({
        config,
        ensureUserFacingQuestion,
        finalizeResult,
        memory,
        observer,
        planResult,
        recordCompletionValidationBlocked,
        resolveCommandApproval,
        runId,
        runToolCall,
        sessionId,
        state: loopState,
        stepNumber,
        toolExecutionContext,
      });
      if (completionOutcome.kind === "finalized") {
        return completionOutcome.result;
      }
      if (completionOutcome.kind === "continue_loop") {
        continue;
      }
      resetCompletionBlockLoopGuard();

      const executionOutcome = await handleExecutionPhase<AgentResult>({
        abortSignal,
        client,
        config,
        finalizeInterrupted,
        finalizeResult,
        lspServerConfigAbsolutePath,
        memory,
        observer,
        planResult,
        resolveCommandApproval,
        runId,
        runToolCall,
        sessionId,
        state: loopState,
        stepNumber,
        toolExecutionContext,
      });
      if (executionOutcome.kind === "finalized") {
        return executionOutcome.result;
      }
    }

    const maxStepsMessage = loopState.lastCompletionGateFailure
      ? `Maximum steps (${loopState.context.maxSteps}) reached. Last completion gate failure: ${loopState.lastCompletionGateFailure}`
      : `Maximum steps (${loopState.context.maxSteps}) reached without completing the task`;

    return await finalizeResult({
      context: loopState.context,
      finalState: "blocked",
      message: maxStepsMessage,
      success: false,
    }, loopState.context.currentStep, "max_steps_reached");
  } catch (error) {
    logError("Agent loop failed", error);
    observer?.onError?.({
      message: error instanceof Error ? error.message : "Unknown error occurred",
    });
    return await finalizeResult({
      context: loopState.context,
      finalState: "error",
      message: error instanceof Error ? error.message : "Unknown error occurred",
      success: false,
    }, loopState.context.currentStep, "loop_error");
  } finally {
    try {
      await memory.flushMessageSink();
    } catch (error) {
      logError("Failed to flush message sink", error);
    }
  }
}
