export type LlmRole = "assistant" | "system" | "tool" | "user";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
}

export interface LlmResponse {
  content: string;
}
