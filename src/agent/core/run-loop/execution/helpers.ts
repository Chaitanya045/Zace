import type { AgentContext, AgentState } from "../../../../types/agent";
import type { AgentConfig } from "../../../../types/config";
import type { ToolResult } from "../../../../types/tool";
import type { AgentObserver } from "../../../observer";
import type { RunLoopMutableState } from "../types";

import { logStep } from "../../../../utils/logger";
import { buildToolCallSignature, detectStagnation } from "../../../stability";
import { addStep } from "../../../state";
import {
  getExecuteCommandText,
  getExecuteCommandWorkingDirectory,
  isReadOnlyInspectionCommand,
} from "../command-safety";
import { appendRunEvent } from "../run-events";

const MAX_CONSECUTIVE_NO_TOOL_CONTINUES = 2;
const REPETITION_LIMIT = 3;

export function emitDiagnosticsObserverEvent(
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

export function hasPriorSuccessfulNoChangeResult(
  state: RunLoopMutableState,
  plannedSignature: string
): boolean {
  for (let index = state.context.steps.length - 1; index >= 0; index -= 1) {
    const step = state.context.steps[index];
    if (!step) {
      continue;
    }
    if (!step.toolCall || !step.toolResult) {
      continue;
    }

    const signature = (step.toolCall.name === "execute_command" || step.toolCall.name === "bash")
      ? buildToolCallSignature(
          step.toolCall.name,
          {
            command: getExecuteCommandText(step.toolCall.arguments) ?? "",
            cwd: getExecuteCommandWorkingDirectory(step.toolCall.arguments) ?? process.cwd(),
          },
          {
            workingDirectory: getExecuteCommandWorkingDirectory(step.toolCall.arguments),
          }
        )
      : buildToolCallSignature(step.toolCall.name, step.toolCall.arguments);
    if (signature !== plannedSignature) {
      continue;
    }

    const changedFiles = step.toolResult.artifacts?.changedFiles ?? [];
    return step.toolResult.success && changedFiles.length === 0;
  }

  return false;
}

export async function handleNoToolCallProgress<TResult>(input: {
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
  memory: {
    addMessage: (
      role: "assistant" | "system" | "tool" | "user",
      content: string
    ) => void;
  };
  planReasoning: string;
  state: RunLoopMutableState;
  stepNumber: number;
}): Promise<
  | { kind: "continue_loop" }
  | { kind: "finalized"; result: TResult }
> {
  input.state.consecutiveNoToolContinues += 1;
  logStep(input.stepNumber, "No tool call specified, continuing...");
  input.state.context = addStep(input.state.context, {
    reasoning: input.planReasoning,
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

export async function maybeFinalizeReadonlyStagnationGuard<TResult>(input: {
  config: AgentConfig;
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
  memory: {
    addMessage: (
      role: "assistant" | "system" | "tool" | "user",
      content: string
    ) => void;
  };
  observer?: AgentObserver;
  runId: string;
  sessionId?: string;
  state: RunLoopMutableState;
  stepNumber: number;
}): Promise<null | { kind: "finalized"; result: TResult }> {
  if (input.state.lastWriteStep === undefined || input.state.lastWriteStep >= input.stepNumber) {
    return null;
  }

  const recentWindow = Math.max(1, Math.trunc(input.config.readonlyStagnationWindow));
  const recentSinceWrite = input.state.context.steps
    .filter((step) => step.step > input.state.lastWriteStep! && step.toolCall && step.toolResult)
    .slice(-recentWindow);
  const hasEnough = recentSinceWrite.length >= recentWindow;
  const allReadonlyInspection = recentSinceWrite.every((step) => {
    if (step.toolCall?.name !== "execute_command" && step.toolCall?.name !== "bash") {
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
    return isReadOnlyInspectionCommand(commandText);
  });
  const validationSinceWrite =
    typeof input.state.lastSuccessfulValidationStep === "number"
      ? input.state.lastSuccessfulValidationStep > input.state.lastWriteStep
      : false;

  if (!hasEnough || !allReadonlyInspection || validationSinceWrite) {
    return null;
  }

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

export async function maybeFinalizeRepetitionGuard<TResult>(input: {
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
  loopSignature: string;
  memory: {
    addMessage: (
      role: "assistant" | "system" | "tool" | "user",
      content: string
    ) => void;
  };
  observer?: AgentObserver;
  runId: string;
  sessionId?: string;
  state: RunLoopMutableState;
  stepNumber: number;
  stagnationWindow: number;
}): Promise<null | { kind: "finalized"; result: TResult }> {
  if (input.loopSignature === input.state.lastToolLoopSignature) {
    input.state.lastToolLoopSignatureCount += 1;
  } else {
    input.state.lastToolLoopSignature = input.loopSignature;
    input.state.lastToolLoopSignatureCount = 1;
  }

  const stagnation = detectStagnation({
    steps: input.state.context.steps,
    window: input.stagnationWindow,
  });
  if (input.state.lastToolLoopSignatureCount < REPETITION_LIMIT) {
    return null;
  }

  const loopGuardReason = stagnation.isStagnant
    ? `Repeated tool outcome with stagnation: ${stagnation.reason}`
    : `Repeated tool outcome observed ${String(input.state.lastToolLoopSignatureCount)} times in a row.`;
  const repetitionMessage =
    `Stopping repeated execution loop: ${loopGuardReason} ` +
    "Please refine the request or provide additional constraints.";
  input.observer?.onLoopGuard?.({
    reason: loopGuardReason,
    repeatCount: input.state.lastToolLoopSignatureCount,
    signature: input.loopSignature,
    step: input.stepNumber,
  });
  await appendRunEvent({
    event: "loop_guard_triggered",
    observer: input.observer,
    payload: {
      reason: loopGuardReason,
      repeatCount: input.state.lastToolLoopSignatureCount,
      signature: input.loopSignature,
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
