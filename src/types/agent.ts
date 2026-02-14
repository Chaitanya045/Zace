import type { ToolCall, ToolResult } from "./tool";

export type AgentState =
  | "blocked"
  | "completed"
  | "error"
  | "executing"
  | "planning"
  | "waiting_for_user";

export interface ScriptMetadata {
  id: string;
  lastTouchedStep: number;
  path: string;
  purpose: string;
  timesUsed: number;
}

export interface AgentStep {
  reasoning: string;
  state: AgentState;
  step: number;
  toolCall: null | ToolCall;
  toolResult: null | ToolResult;
}

export interface AgentContext {
  currentStep: number;
  maxSteps: number;
  fileSummaries: Map<string, string>;
  scriptCatalog: Map<string, ScriptMetadata>;
  steps: AgentStep[];
  task: string;
}
