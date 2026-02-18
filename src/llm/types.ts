export type LlmRole = "assistant" | "system" | "tool" | "user";
export type LlmCallKind = "compaction" | "executor" | "planner" | "safety";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmResponseFormatJsonSchema {
  type: "json_schema";
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  callKind?: LlmCallKind;
  messages: LlmMessage[];
  normalizeToolRole?: boolean;
  responseFormat?: LlmResponseFormatJsonSchema;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  content: string;
  normalized?: {
    reasons: string[];
  };
  usage?: LlmUsage;
}
