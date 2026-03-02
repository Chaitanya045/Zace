import { randomUUID } from "node:crypto";

import type { SessionPendingActionEntry } from "../tools/session";
import type { PermissionNext } from "./next";

import { appendSessionPendingAction, findLatestOpenPendingAction, readSessionEntries } from "../tools/session";

type PendingPermissionContext = {
  always: string[];
  metadata: Record<string, unknown>;
  patterns: string[];
  permission: string;
  requestId: string;
  reply?: PermissionNext.Reply;
  replyMessage?: string;
  tool?: {
    callId: string;
    messageId: string;
  };
};

function parsePendingPermissionContext(entry: SessionPendingActionEntry): null | PendingPermissionContext {
  const raw = entry.context;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const permission = raw.permission;
  const requestId = raw.requestId;
  const patterns = raw.patterns;
  const always = raw.always;
  const metadata = raw.metadata;

  if (typeof permission !== "string" || permission.length === 0) {
    return null;
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    return null;
  }
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string" || p.length === 0)) {
    return null;
  }
  if (!Array.isArray(always) || always.some((p) => typeof p !== "string" || p.length === 0)) {
    return null;
  }
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const reply = raw.reply;
  const replyMessage = raw.replyMessage;
  const tool = raw.tool;

  return {
    always: always as string[],
    metadata: metadata as Record<string, unknown>,
    patterns: patterns as string[],
    permission,
    reply:
      reply === "once" || reply === "always" || reply === "reject"
        ? (reply as PermissionNext.Reply)
        : undefined,
    replyMessage: typeof replyMessage === "string" && replyMessage.trim() ? replyMessage : undefined,
    requestId,
    tool:
      tool &&
      typeof tool === "object" &&
      typeof (tool as { callId?: unknown }).callId === "string" &&
      typeof (tool as { messageId?: unknown }).messageId === "string"
        ? {
            callId: (tool as { callId: string }).callId,
            messageId: (tool as { messageId: string }).messageId,
          }
        : undefined,
  };
}

export type OpenPendingPermission = {
  context: PendingPermissionContext;
  entry: SessionPendingActionEntry;
};

export async function createPendingPermissionAction(input: {
  always: string[];
  metadata?: Record<string, unknown>;
  patterns: string[];
  permission: string;
  prompt: string;
  runId: string;
  sessionId: string;
  tool?: {
    callId: string;
    messageId: string;
  };
}): Promise<string> {
  const requestId = randomUUID();
  await appendSessionPendingAction(input.sessionId, {
    context: {
      always: input.always,
      metadata: input.metadata ?? {},
      patterns: input.patterns,
      permission: input.permission,
      requestId,
      tool: input.tool,
    },
    kind: "permission",
    prompt: input.prompt,
    runId: input.runId,
    sessionId: input.sessionId,
    status: "open",
  });
  return requestId;
}

export async function resolvePendingPermissionAction(input: {
  entry: SessionPendingActionEntry;
  reply: PermissionNext.Reply;
  replyMessage?: string;
  sessionId: string;
}): Promise<void> {
  await appendSessionPendingAction(input.sessionId, {
    context: {
      ...input.entry.context,
      reply: input.reply,
      replyMessage: input.replyMessage,
    },
    kind: input.entry.kind,
    prompt: input.entry.prompt,
    runId: input.entry.runId,
    sessionId: input.entry.sessionId,
    status: "resolved",
  });
}

export async function findOpenPendingPermission(input: {
  maxAgeMs: number;
  sessionId: string;
}): Promise<null | OpenPendingPermission> {
  const entries = await readSessionEntries(input.sessionId);
  const pending = findLatestOpenPendingAction(entries, "permission");
  if (!pending) {
    return null;
  }
  const context = parsePendingPermissionContext(pending);
  if (!context) {
    return null;
  }
  const createdAt = Date.parse(pending.timestamp);
  const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : Number.POSITIVE_INFINITY;
  if (ageMs > input.maxAgeMs) {
    return null;
  }
  return { context, entry: pending };
}
