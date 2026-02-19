import type { AgentContext, AgentState } from "../../../types/agent";
import type { AgentConfig } from "../../../types/config";
import type { ToolExecutionContext, ToolResult } from "../../../types/tool";
import type { CompletionGate } from "../../completion";
import type { CompletionGateResult } from "../../completion/gate-evaluation";
import type { AgentObserver } from "../../observer";
import type { PlanResult } from "../../planner/plan";
import type {
  CommandApprovalResult,
  RunLoopMutableState,
  ToolCallLike,
} from "./types";

import { logStep } from "../../../utils/logger";
import {
  describeCompletionPlan,
  discoverAutomaticCompletionGates,
  mergeCompletionGates,
} from "../../completion";
import {
  buildCompletionFailureMessage,
  parsePlannerCompletionGates,
  shouldBlockForFreshness,
  shouldBlockForMaskedGates,
} from "../../completion/gate-evaluation";
import {
  buildLspBootstrapRequirementMessage,
  shouldBlockForBootstrap,
} from "../../lsp-bootstrap/state-machine";
import { addStep } from "../../state";
import { appendRunEvent } from "./run-events";

export type CompletionPhaseOutcome<TResult> =
  | { kind: "continue_loop" }
  | { kind: "finalized"; result: TResult }
  | { kind: "proceed_execution" };

type CompletionValidationBlockedRecord = {
  blockLoopGuardTriggered: boolean;
  repeatCount: number;
  repeatLimit: number;
};

async function runCompletionGates(
  gates: CompletionGate[],
  workingDirectory: string,
  executeTool: (toolCall: ToolCallLike, context?: ToolExecutionContext) => Promise<ToolResult>,
  toolExecutionContext?: ToolExecutionContext
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
      }, toolExecutionContext);
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

export async function handleCompletionPhase<TResult>(input: {
  config: AgentConfig;
  ensureUserFacingQuestion: (message: string) => string;
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
  planResult: PlanResult;
  recordCompletionValidationBlocked: (
    step: number,
    reason: string,
    extraPayload?: Record<string, unknown>
  ) => Promise<CompletionValidationBlockedRecord>;
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
}): Promise<CompletionPhaseOutcome<TResult>> {
  const maybeFinalizeRepeatedCompletionBlock = async (
    failureMessage: string,
    blockedRecord: CompletionValidationBlockedRecord
  ): Promise<CompletionPhaseOutcome<TResult> | undefined> => {
    if (!blockedRecord.blockLoopGuardTriggered) {
      return undefined;
    }

    const repeatedBlockMessage = input.ensureUserFacingQuestion(
      `I am repeatedly blocked by the same completion condition (${String(blockedRecord.repeatCount)}/${String(blockedRecord.repeatLimit)}): ${failureMessage}\nPlease resolve this blocker or tell me how you want to proceed.`
    );
    input.memory.addMessage("assistant", repeatedBlockMessage);
    input.state.context = addStep(input.state.context, {
      reasoning:
        `Repeated completion blocking detected (${String(blockedRecord.repeatCount)}/${String(blockedRecord.repeatLimit)}). ` +
        failureMessage,
      state: "waiting_for_user",
      step: input.stepNumber,
      toolCall: null,
      toolResult: null,
    });
    return {
      kind: "finalized",
      result: await input.finalizeResult({
        context: input.state.context,
        finalState: "waiting_for_user",
        message: repeatedBlockMessage,
        success: false,
      }, input.stepNumber, "completion_block_loop_guard_triggered"),
    };
  };

  if (input.planResult.action === "continue") {
    return { kind: "proceed_execution" };
  }

  if (input.planResult.action === "complete") {
    const strictCompletionValidation = input.config.completionValidationMode === "strict";
    const validationWorkingDirectory =
      input.state.lastWriteWorkingDirectory ?? input.state.lastExecutionWorkingDirectory;
    const lspBootstrapBlocking = shouldBlockForBootstrap({
      completionRequireLsp: input.config.completionRequireLsp,
      lspBootstrapBlockOnFailed: input.config.lspBootstrapBlockOnFailed,
      lspEnabled: input.config.lspEnabled,
      lspState: input.state.lspBootstrap.state,
    });
    if (lspBootstrapBlocking) {
      const bootstrapMessage = buildLspBootstrapRequirementMessage(
        input.config.lspServerConfigPath,
        Array.from(input.state.lspBootstrap.pendingChangedFiles),
        input.state.lspBootstrap.lastFailureReason ?? undefined
      );
      const failureMessage =
        `Completion blocked until LSP bootstrap is resolved. ${bootstrapMessage}`;
      input.state.lastCompletionGateFailure = failureMessage;
      const blockedRecord = await input.recordCompletionValidationBlocked(input.stepNumber, failureMessage, {
        lspBootstrapState: input.state.lspBootstrap.state,
        lspFailureReason: input.state.lspBootstrap.lastFailureReason,
        provisionAttempts: input.state.lspBootstrap.provisionAttempts,
      });
      const repeatedBlockOutcome = await maybeFinalizeRepeatedCompletionBlock(
        failureMessage,
        blockedRecord
      );
      if (repeatedBlockOutcome) {
        return repeatedBlockOutcome;
      }

      if (
        !input.config.lspAutoProvision ||
        input.state.lspBootstrap.provisionAttempts >= input.config.lspProvisionMaxAttempts
      ) {
        const attemptedCommandsText = input.state.lspBootstrap.attemptedCommands.length > 0
          ? `\nRecent bootstrap commands:\n- ${input.state.lspBootstrap.attemptedCommands.join("\n- ")}`
          : "";
        const waitMessage =
          `${failureMessage}\nReached bootstrap remediation limit (${String(input.config.lspProvisionMaxAttempts)} attempts).` +
          `${attemptedCommandsText}`;
        input.memory.addMessage("assistant", waitMessage);
        input.state.context = addStep(input.state.context, {
          reasoning: `Completion blocked by unresolved LSP bootstrap after bounded retries. ${waitMessage}`,
          state: "waiting_for_user",
          step: input.stepNumber,
          toolCall: null,
          toolResult: null,
        });
        return {
          kind: "finalized",
          result: await input.finalizeResult({
            context: input.state.context,
            finalState: "waiting_for_user",
            message: waitMessage,
            success: false,
          }, input.stepNumber, "lsp_bootstrap_retry_limit_reached"),
        };
      }

      input.state.context = addStep(input.state.context, {
        reasoning: `Completion requested while LSP bootstrap is pending. ${bootstrapMessage}`,
        state: "executing",
        step: input.stepNumber,
        toolCall: null,
        toolResult: null,
      });
      input.memory.addMessage(
        "assistant",
        `Completion gate check result: ${failureMessage}`
      );
      logStep(input.stepNumber, `Completion blocked by pending LSP bootstrap: ${failureMessage}`);
      return { kind: "continue_loop" };
    }

    const plannerCompletionGates = parsePlannerCompletionGates(input.planResult.completionGateCommands);
    if (plannerCompletionGates.length > 0) {
      const mergedWithPlanner = mergeCompletionGates(input.state.completionPlan.gates, plannerCompletionGates);
      if (mergedWithPlanner.length !== input.state.completionPlan.gates.length) {
        input.state.completionPlan = {
          ...input.state.completionPlan,
          gates: mergedWithPlanner,
          source: input.state.completionPlan.gates.length === 0 ? "planner" : "merged",
        };
        input.memory.addMessage(
          "assistant",
          `Planner supplied completion gates: ${describeCompletionPlan(input.state.completionPlan).join(" | ")}`
        );
      }
    }

    const shouldDiscoverGates =
      input.state.lastWriteStep !== undefined &&
      (
        (strictCompletionValidation && input.config.completionRequireDiscoveredGates) ||
        (
          input.state.completionPlan.gates.length === 0 &&
          !input.planResult.completionGatesDeclaredNone
        )
      );
    if (shouldDiscoverGates) {
      const autoDiscoveredGates = await discoverAutomaticCompletionGates(validationWorkingDirectory);
      if (autoDiscoveredGates.length > 0) {
        const mergedWithDiscovered = mergeCompletionGates(
          input.state.completionPlan.gates,
          autoDiscoveredGates
        );
        if (mergedWithDiscovered.length !== input.state.completionPlan.gates.length) {
          input.state.completionPlan = {
            ...input.state.completionPlan,
            gates: mergedWithDiscovered,
            source: input.state.completionPlan.gates.length === 0 ? "auto_discovered" : "merged",
          };
          input.memory.addMessage(
            "assistant",
            `Runtime merged discovered completion gates in ${validationWorkingDirectory}: ${describeCompletionPlan(input.state.completionPlan).join(" | ")}`
          );
        }
      }
    }

    const strictNoneDeclaredAfterWrites =
      strictCompletionValidation &&
      input.planResult.completionGatesDeclaredNone &&
      input.state.lastWriteStep !== undefined;
    if (strictNoneDeclaredAfterWrites && input.state.completionPlan.gates.length > 0) {
      input.memory.addMessage(
        "assistant",
        "Planner declared `gates: none`, but runtime discovered validation gates after file changes; enforcing discovered gates in strict mode."
      );
    }
    if (strictNoneDeclaredAfterWrites && input.state.completionPlan.gates.length === 0) {
      const failureMessage =
        "Completion blocked: `gates: none` is not allowed after file changes in strict mode. Provide validation gates and rerun.";
      input.state.lastCompletionGateFailure = failureMessage;
      const blockedRecord = await input.recordCompletionValidationBlocked(input.stepNumber, failureMessage, {
        completionValidationMode: input.config.completionValidationMode,
        lastWriteStep: input.state.lastWriteStep,
      });
      const repeatedBlockOutcome = await maybeFinalizeRepeatedCompletionBlock(
        failureMessage,
        blockedRecord
      );
      if (repeatedBlockOutcome) {
        return repeatedBlockOutcome;
      }
      input.state.context = addStep(input.state.context, {
        reasoning: `Completion requested with gates:none after writes. ${failureMessage}`,
        state: "executing",
        step: input.stepNumber,
        toolCall: null,
        toolResult: null,
      });
      input.memory.addMessage("assistant", `Completion gate check result: ${failureMessage}`);
      logStep(input.stepNumber, failureMessage);
      return { kind: "continue_loop" };
    }

    if (input.state.completionPlan.gates.length === 0 && !input.planResult.completionGatesDeclaredNone) {
      const failureMessage =
        "No completion gates available. Provide `GATES: <command_1>;;<command_2>` with COMPLETE, use DONE_CRITERIA, or explicitly declare `GATES: none`.";
      input.state.lastCompletionGateFailure = failureMessage;
      const blockedRecord = await input.recordCompletionValidationBlocked(input.stepNumber, failureMessage, {
        completionValidationMode: input.config.completionValidationMode,
      });
      const repeatedBlockOutcome = await maybeFinalizeRepeatedCompletionBlock(
        failureMessage,
        blockedRecord
      );
      if (repeatedBlockOutcome) {
        return repeatedBlockOutcome;
      }
      input.state.context = addStep(input.state.context, {
        reasoning: `Completion requested without gates. ${failureMessage}`,
        state: "executing",
        step: input.stepNumber,
        toolCall: null,
        toolResult: null,
      });
      input.memory.addMessage(
        "assistant",
        `Completion gate check result: ${failureMessage}`
      );
      logStep(input.stepNumber, `Completion blocked by missing gates: ${failureMessage}`);
      return { kind: "continue_loop" };
    }

    const maskedGate = shouldBlockForMaskedGates({
      gateDisallowMasking: input.config.gateDisallowMasking,
      gates: input.state.completionPlan.gates,
      strictCompletionValidation,
    });
    if (maskedGate) {
      const failureMessage =
        `Completion blocked: validation gate ${maskedGate.gate.label} appears masked (${maskedGate.reason}). ` +
        "Provide an unmasked validation command.";
      input.state.lastCompletionGateFailure = failureMessage;
      await appendRunEvent({
        event: "validation_gate_masked",
        observer: input.observer,
        payload: {
          command: maskedGate.gate.command,
          gateLabel: maskedGate.gate.label,
          reason: maskedGate.reason,
        },
        phase: "finalizing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
      const blockedRecord = await input.recordCompletionValidationBlocked(input.stepNumber, failureMessage, {
        gate: maskedGate.gate.label,
        reason: maskedGate.reason,
      });
      const repeatedBlockOutcome = await maybeFinalizeRepeatedCompletionBlock(
        failureMessage,
        blockedRecord
      );
      if (repeatedBlockOutcome) {
        return repeatedBlockOutcome;
      }
      input.memory.addMessage("assistant", `Completion gate check result: ${failureMessage}`);
      input.state.context = addStep(input.state.context, {
        reasoning: failureMessage,
        state: "executing",
        step: input.stepNumber,
        toolCall: null,
        toolResult: null,
      });
      logStep(input.stepNumber, failureMessage);
      return { kind: "continue_loop" };
    }

    if (input.state.completionPlan.gates.length > 0) {
      let approvalBlockedMessage: null | string = null;
      for (const gate of input.state.completionPlan.gates) {
        const gateApproval = await input.resolveCommandApproval({
          command: gate.command,
          workingDirectory: validationWorkingDirectory,
        });

        if (gateApproval.status === "allow") {
          if (gateApproval.requiredApproval) {
            input.observer?.onApprovalResolved?.({
              decision: "allow",
              scope: gateApproval.scope,
            });
            await appendRunEvent({
              event: "approval_resolved",
              observer: input.observer,
              payload: {
                command: gate.command,
                decision: "allow",
                scope: gateApproval.scope,
              },
              phase: "approval",
              runId: input.runId,
              sessionId: input.sessionId,
              step: input.stepNumber,
            });
          }
          continue;
        }

        if (gateApproval.status === "deny") {
          input.observer?.onApprovalResolved?.({
            decision: "deny",
            scope: gateApproval.scope,
          });
          await appendRunEvent({
            event: "approval_resolved",
            observer: input.observer,
            payload: {
              command: gate.command,
              decision: "deny",
              scope: gateApproval.scope,
            },
            phase: "approval",
            runId: input.runId,
            sessionId: input.sessionId,
            step: input.stepNumber,
          });
          approvalBlockedMessage = gateApproval.message;
          break;
        }

        input.observer?.onApprovalRequested?.({
          command: gate.command,
          reason: gateApproval.reason,
          step: input.stepNumber,
        });
        input.memory.addMessage("assistant", gateApproval.message);
        input.state.context = addStep(input.state.context, {
          reasoning: `Waiting for explicit confirmation before running destructive completion gate. ${gateApproval.reason}`,
          state: "waiting_for_user",
          step: input.stepNumber,
          toolCall: null,
          toolResult: null,
        });
        await appendRunEvent({
          event: "approval_requested",
          observer: input.observer,
          payload: {
            command: gate.command,
            commandSignature: gateApproval.commandSignature,
            reason: gateApproval.reason,
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
            message: gateApproval.message,
            success: false,
          }, input.stepNumber, "destructive_completion_gate_confirmation"),
        };
      }

      if (approvalBlockedMessage) {
        const failureMessage = `Completion blocked by approval policy: ${approvalBlockedMessage}`;
        input.state.lastCompletionGateFailure = failureMessage;
        const blockedRecord = await input.recordCompletionValidationBlocked(input.stepNumber, failureMessage, {
          completionValidationMode: input.config.completionValidationMode,
        });
        const repeatedBlockOutcome = await maybeFinalizeRepeatedCompletionBlock(
          failureMessage,
          blockedRecord
        );
        if (repeatedBlockOutcome) {
          return repeatedBlockOutcome;
        }
        input.memory.addMessage("assistant", failureMessage);
        input.state.context = addStep(input.state.context, {
          reasoning: failureMessage,
          state: "executing",
          step: input.stepNumber,
          toolCall: null,
          toolResult: null,
        });
        logStep(input.stepNumber, failureMessage);
        return { kind: "continue_loop" };
      }

      const gateResults = await runCompletionGates(
        input.state.completionPlan.gates,
        validationWorkingDirectory,
        input.runToolCall,
        input.toolExecutionContext
      );
      const failureMessage = buildCompletionFailureMessage(gateResults);

      input.memory.addMessage(
        "assistant",
        `Completion gate check result: ${failureMessage}`
      );

      const hasFailure = gateResults.some((gateResult) => !gateResult.result.success);
      if (hasFailure) {
        input.state.lastCompletionGateFailure = failureMessage;
        const blockedRecord = await input.recordCompletionValidationBlocked(input.stepNumber, failureMessage, {
          completionValidationMode: input.config.completionValidationMode,
        });
        const repeatedBlockOutcome = await maybeFinalizeRepeatedCompletionBlock(
          failureMessage,
          blockedRecord
        );
        if (repeatedBlockOutcome) {
          return repeatedBlockOutcome;
        }
        input.state.context = addStep(input.state.context, {
          reasoning: `Completion requested but gates failed. ${failureMessage}`,
          state: "executing",
          step: input.stepNumber,
          toolCall: null,
          toolResult: null,
        });
        logStep(input.stepNumber, `Completion blocked by gates: ${failureMessage}`);
        return { kind: "continue_loop" };
      }

      input.state.lastSuccessfulValidationStep = input.stepNumber;
    }

    if (shouldBlockForFreshness({
      lastSuccessfulValidationStep: input.state.lastSuccessfulValidationStep,
      lastWriteStep: input.state.lastWriteStep,
      strictCompletionValidation,
    })) {
      const failureMessage =
        "Completion blocked: validation freshness check failed. Re-run validation gates after the latest file changes.";
      input.state.lastCompletionGateFailure = failureMessage;
      const blockedRecord = await input.recordCompletionValidationBlocked(input.stepNumber, failureMessage, {
        completionValidationMode: input.config.completionValidationMode,
        lastSuccessfulValidationStep: input.state.lastSuccessfulValidationStep,
        lastWriteStep: input.state.lastWriteStep,
      });
      const repeatedBlockOutcome = await maybeFinalizeRepeatedCompletionBlock(
        failureMessage,
        blockedRecord
      );
      if (repeatedBlockOutcome) {
        return repeatedBlockOutcome;
      }
      input.memory.addMessage("assistant", `Completion gate check result: ${failureMessage}`);
      input.state.context = addStep(input.state.context, {
        reasoning: failureMessage,
        state: "executing",
        step: input.stepNumber,
        toolCall: null,
        toolResult: null,
      });
      logStep(input.stepNumber, failureMessage);
      return { kind: "continue_loop" };
    }

    input.state.context = addStep(input.state.context, {
      reasoning: input.planResult.reasoning,
      state: "completed",
      step: input.stepNumber,
      toolCall: null,
      toolResult: null,
    });
    input.state.lastCompletionGateFailure = null;
    return {
      kind: "finalized",
      result: await input.finalizeResult({
        context: input.state.context,
        finalState: "completed",
        message: input.planResult.userMessage ?? input.planResult.reasoning,
        success: true,
      }, input.stepNumber, "planner_complete"),
    };
  }

  if (input.planResult.action === "blocked") {
    const blockedMessage = input.planResult.userMessage ?? input.planResult.reasoning;
    input.state.context = addStep(input.state.context, {
      reasoning: input.planResult.reasoning,
      state: "blocked",
      step: input.stepNumber,
      toolCall: null,
      toolResult: null,
    });
    return {
      kind: "finalized",
      result: await input.finalizeResult({
        context: input.state.context,
        finalState: "blocked",
        message: blockedMessage,
        success: false,
      }, input.stepNumber, "planner_blocked"),
    };
  }

  const askUserMessage = input.ensureUserFacingQuestion(
    input.planResult.userMessage ?? input.planResult.reasoning
  );
  input.state.context = addStep(input.state.context, {
    reasoning: input.planResult.reasoning,
    state: "waiting_for_user",
    step: input.stepNumber,
    toolCall: null,
    toolResult: null,
  });
  return {
    kind: "finalized",
    result: await input.finalizeResult({
      context: input.state.context,
      finalState: "waiting_for_user",
      message: askUserMessage,
      success: false,
    }, input.stepNumber, "planner_ask_user"),
  };
}
