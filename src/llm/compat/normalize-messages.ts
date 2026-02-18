import type { LlmCallKind, LlmMessage } from "../types";

const TOOL_DIGEST_PREFIX = "Tool memory digest:\n";
const TOOL_DIGEST_MAX_CHARS = 8_000;

export type MessageNormalizationReason =
  | "assistant_role_coercion"
  | "tool_role_coercion"
  | "tool_role_disabled";

export type MessageNormalizationResult = {
  changed: boolean;
  messages: LlmMessage[];
  reasons: MessageNormalizationReason[];
};

function truncateToolDigest(content: string): string {
  if (content.length <= TOOL_DIGEST_MAX_CHARS) {
    return content;
  }

  const remaining = content.length - TOOL_DIGEST_MAX_CHARS;
  return `${content.slice(0, TOOL_DIGEST_MAX_CHARS)}\n...[truncated ${String(remaining)} chars]`;
}

function normalizeToolMessageRole(content: string): string {
  const normalized = content.trim();
  const digest = truncateToolDigest(normalized);
  if (!digest) {
    return TOOL_DIGEST_PREFIX.trim();
  }

  return `${TOOL_DIGEST_PREFIX}${digest}`;
}

function shouldNormalizeToolRole(callKind: LlmCallKind | undefined, enabled: boolean): boolean {
  if (!enabled) {
    return false;
  }

  return callKind === "compaction" || callKind === "planner";
}

export function normalizeMessagesForTransport(input: {
  callKind?: LlmCallKind;
  messages: LlmMessage[];
  normalizeToolRole: boolean;
}): MessageNormalizationResult {
  const reasons = new Set<MessageNormalizationReason>();
  const normalizeToolRole = shouldNormalizeToolRole(input.callKind, input.normalizeToolRole);

  const messages = input.messages.map((message) => {
    if (message.role === "tool") {
      if (!input.normalizeToolRole) {
        reasons.add("tool_role_disabled");
        return message;
      }

      if (!normalizeToolRole && (input.callKind === "executor" || input.callKind === "safety")) {
        reasons.add("tool_role_coercion");
      }

      if (normalizeToolRole || input.callKind === "executor" || input.callKind === "safety") {
        reasons.add("tool_role_coercion");
        return {
          content: normalizeToolMessageRole(message.content),
          role: "assistant" as const,
        };
      }
    }

    return message;
  });

  const changed = messages.some((message, index) => {
    const original = input.messages[index];
    return !original || message.role !== original.role || message.content !== original.content;
  });

  if (changed && !reasons.has("tool_role_coercion")) {
    reasons.add("assistant_role_coercion");
  }

  return {
    changed,
    messages,
    reasons: Array.from(reasons),
  };
}
