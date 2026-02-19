import type { AgentContext } from "../../../types/agent";
import type { CompletionPlan } from "../../completion";
import type { LspBootstrapState } from "../../lsp-bootstrap/state-machine";

export type ToolCallLike = {
  arguments: Record<string, unknown>;
  name: string;
};

export type RunEventPhase = "approval" | "executing" | "finalizing" | "planning";

export type CommandApprovalResult =
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

export type LspBootstrapContext = {
  attemptedCommands: string[];
  lastFailureReason: null | string;
  pendingChangedFiles: Set<string>;
  provisionAttempts: number;
  state: LspBootstrapState;
};

export type RunLoopMutableState = {
  completionBlockedReason: null | string;
  completionBlockedReasonRepeatCount: number;
  completionPlan: CompletionPlan;
  consecutiveNoToolContinues: number;
  context: AgentContext;
  lastCompletionGateFailure: null | string;
  lastExecutionWorkingDirectory: string;
  lastSuccessfulValidationStep: number | undefined;
  lastToolLoopSignature: string;
  lastToolLoopSignatureCount: number;
  lastWriteLspErrorCount: number | undefined;
  lastWriteStep: number | undefined;
  lastWriteWorkingDirectory: string | undefined;
  lspBootstrap: LspBootstrapContext;
  toolCallSignatureHistory: string[];
};
