import type { MessagePartV2, MessageV2 } from "./message-v2";

export type SessionStoreWrite = {
  appendMessage(message: MessageV2): Promise<void>;
  appendPartDelta(input: { delta: unknown; messageId: string; partId: string }): Promise<void>;
};

export type SessionStoreRead = {
  readMessages(): Promise<MessageV2[]>;
};

export type SessionStore = SessionStoreRead & SessionStoreWrite;

export function applyPartDelta(part: MessagePartV2, delta: unknown): MessagePartV2 {
  if (!delta || typeof delta !== "object") {
    return part;
  }

  // Shallow merge of part fields; processor owns schema-level correctness.
  const deltaObj = delta as Record<string, unknown>;
  return {
    ...part,
    ...deltaObj,
  } as MessagePartV2;
}
