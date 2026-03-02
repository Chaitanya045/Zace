import type { SessionEntry } from "../tools/session";

import {
  appendSessionMessagePartDelta,
  appendSessionMessageV2,
  readSessionEntries,
} from "../tools/session";
import { applyPartDelta, type SessionStore } from "./store";
import type { MessageV2 } from "./message-v2";

function coerceMessageEntries(entries: SessionEntry[]): MessageV2[] {
  const messages = new Map<string, MessageV2>();
  const deltas: Array<{ delta: unknown; messageId: string; partId: string }> = [];

  for (const entry of entries) {
    if (entry.type === "message_v2") {
      messages.set(entry.message.id, entry.message);
      continue;
    }
    if (entry.type === "message_part_delta") {
      deltas.push({
        delta: entry.delta,
        messageId: entry.messageId,
        partId: entry.partId,
      });
    }
  }

  for (const delta of deltas) {
    const message = messages.get(delta.messageId);
    if (!message) {
      continue;
    }
    const partIndex = message.parts.findIndex((part) => part.id === delta.partId);
    if (partIndex === -1) {
      continue;
    }
    const existing = message.parts[partIndex];
    if (!existing) {
      continue;
    }
    const updated = applyPartDelta(existing, delta.delta);
    message.parts = message.parts.map((part, index) => (index === partIndex ? updated : part));
  }

  return Array.from(messages.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createJsonlSessionStore(sessionId: string): SessionStore {
  return {
    async appendMessage(message) {
      await appendSessionMessageV2(sessionId, { message });
    },
    async appendPartDelta(input) {
      await appendSessionMessagePartDelta(sessionId, {
        delta: input.delta,
        messageId: input.messageId,
        partId: input.partId,
      });
    },
    async readMessages() {
      const entries = await readSessionEntries(sessionId);
      return coerceMessageEntries(entries);
    },
  } satisfies SessionStore;
}
