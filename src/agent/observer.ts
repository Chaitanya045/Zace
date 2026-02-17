export interface AgentCompactionEvent {
  ratioPercent: number;
  step: number;
}

export interface AgentDiagnosticsEvent {
  errorCount: number;
  files: string[];
  step: number;
}

export interface AgentErrorEvent {
  message: string;
}

export interface AgentLoopGuardEvent {
  reason: string;
  repeatCount: number;
  signature: string;
  step: number;
}

export interface AgentApprovalRequestedEvent {
  command: string;
  reason: string;
  step: number;
}

export interface AgentApprovalResolvedEvent {
  decision: "allow" | "deny";
  scope: "once" | "session" | "workspace";
}

export interface AgentRunEvent {
  event: string;
  phase: "approval" | "executing" | "finalizing" | "planning";
  step: number;
}

export interface AgentExecutorStreamEvent {
  toolName: string;
}

export interface AgentExecutorTokenEvent {
  token: string;
  toolName: string;
}

export interface AgentStepStartEvent {
  maxSteps: number;
  step: number;
}

export interface AgentToolCallEvent {
  arguments: Record<string, unknown>;
  attempt: number;
  name: string;
  step: number;
}

export interface AgentToolResultEvent {
  attempt: number;
  error?: string;
  name: string;
  output: string;
  step: number;
  success: boolean;
}

export interface AgentObserver {
  onApprovalRequested?: (event: AgentApprovalRequestedEvent) => void;
  onApprovalResolved?: (event: AgentApprovalResolvedEvent) => void;
  onCompaction?: (event: AgentCompactionEvent) => void;
  onDiagnostics?: (event: AgentDiagnosticsEvent) => void;
  onError?: (event: AgentErrorEvent) => void;
  onLoopGuard?: (event: AgentLoopGuardEvent) => void;
  onRunEvent?: (event: AgentRunEvent) => void;
  onExecutorStreamEnd?: (event: AgentExecutorStreamEvent) => void;
  onExecutorStreamStart?: (event: AgentExecutorStreamEvent) => void;
  onExecutorStreamToken?: (event: AgentExecutorTokenEvent) => void;
  onPlannerStreamEnd?: () => void;
  onPlannerStreamStart?: () => void;
  onPlannerStreamToken?: (token: string) => void;
  onStepStart?: (event: AgentStepStartEvent) => void;
  onToolCall?: (event: AgentToolCallEvent) => void;
  onToolResult?: (event: AgentToolResultEvent) => void;
}
