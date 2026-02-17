export interface AgentCompactionEvent {
  ratioPercent: number;
  step: number;
}

export interface AgentErrorEvent {
  message: string;
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
  onCompaction?: (event: AgentCompactionEvent) => void;
  onError?: (event: AgentErrorEvent) => void;
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
