import type { ToolCall, ToolResult } from "./tool";

export type AgentState = "blocked" | "completed" | "error" | "executing" | "planning";

export interface AgentStep {
  step: number;
  state: AgentState;
  toolCall: null | ToolCall;
  toolResult: null | ToolResult;
  reasoning: string;
}

export interface AgentContext {
  task: string;
  currentStep: number;
  maxSteps: number;
  steps: AgentStep[];
  fileSummaries: Map<string, string>;
}
