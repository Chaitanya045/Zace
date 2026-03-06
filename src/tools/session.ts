import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { messageV2Schema } from "../session/message-v2";

const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SESSIONS_DIRECTORY_PATH = ".zace/sessions";

export const sessionMessageRoleSchema = z.enum(["assistant", "system", "tool", "user"]);

const sessionMessageEntrySchema = z.object({
  content: z.string(),
  role: sessionMessageRoleSchema,
  timestamp: z.string(),
  type: z.literal("message"),
});

const sessionSummaryEntrySchema = z.object({
  finalState: z.string(),
  success: z.boolean(),
  summary: z.string(),
  timestamp: z.string(),
  type: z.literal("summary"),
});

const sessionMessageV2EntrySchema = z.object({
  message: messageV2Schema,
  timestamp: z.string(),
  type: z.literal("message_v2"),
});

const sessionMessagePartDeltaEntrySchema = z.object({
  delta: z.unknown(),
  messageId: z.string().min(1),
  partId: z.string().min(1),
  timestamp: z.string(),
  type: z.literal("message_part_delta"),
});

const sessionMetaEntrySchema = z.object({
  timestamp: z.string(),
  title: z.string().min(1),
  type: z.literal("session_meta"),
});

const sessionCatalogMetadataSchema = z.object({
  title: z.string().min(1).optional(),
});

const sessionRunEntrySchema = z.object({
  assistantMessage: z.string(),
  durationMs: z.number().int().nonnegative(),
  endedAt: z.string(),
  finalState: z.string(),
  sessionId: z.string(),
  startedAt: z.string(),
  steps: z.number().int().nonnegative(),
  success: z.boolean(),
  summary: z.string(),
  task: z.string(),
  type: z.literal("run"),
  userMessage: z.string(),
});

const sessionRunEventPhaseSchema = z.enum(["approval", "executing", "finalizing", "planning"]);

const sessionRunEventEntrySchema = z.object({
  event: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  phase: sessionRunEventPhaseSchema,
  runId: z.string().min(1),
  step: z.number().int().nonnegative(),
  timestamp: z.string(),
  type: z.literal("run_event"),
});

const sessionPendingActionKindSchema = z.enum(["approval", "loop_guard", "permission"]);
const sessionPendingActionStatusSchema = z.enum(["open", "resolved"]);

const sessionPendingActionEntrySchema = z.object({
  context: z.record(z.string(), z.unknown()),
  kind: sessionPendingActionKindSchema,
  prompt: z.string(),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  status: sessionPendingActionStatusSchema,
  timestamp: z.string(),
  type: z.literal("pending_action"),
});

const sessionApprovalRuleScopeSchema = z.enum(["session", "workspace"]);
const sessionApprovalRuleDecisionSchema = z.enum(["allow", "deny"]);

const sessionPermissionRuleActionSchema = z.enum(["allow", "ask", "deny"]);

const sessionPermissionRuleEntrySchema = z.object({
  action: sessionPermissionRuleActionSchema,
  pattern: z.string().min(1),
  permission: z.string().min(1),
  scope: sessionApprovalRuleScopeSchema,
  timestamp: z.string(),
  type: z.literal("permission_rule"),
});

const sessionApprovalRuleEntrySchema = z.object({
  decision: sessionApprovalRuleDecisionSchema,
  pattern: z.string().min(1),
  scope: sessionApprovalRuleScopeSchema,
  timestamp: z.string(),
  type: z.literal("approval_rule"),
});

export const sessionEntrySchema = z.discriminatedUnion("type", [
  sessionApprovalRuleEntrySchema,
  sessionMessageEntrySchema,
  sessionMessagePartDeltaEntrySchema,
  sessionMetaEntrySchema,
  sessionMessageV2EntrySchema,
  sessionPendingActionEntrySchema,
  sessionPermissionRuleEntrySchema,
  sessionRunEventEntrySchema,
  sessionSummaryEntrySchema,
  sessionRunEntrySchema,
]);

export type SessionEntry = z.infer<typeof sessionEntrySchema>;
export type SessionApprovalRuleDecision = z.infer<typeof sessionApprovalRuleDecisionSchema>;
export type SessionApprovalRuleEntry = Extract<SessionEntry, { type: "approval_rule" }>;
export type SessionApprovalRuleScope = z.infer<typeof sessionApprovalRuleScopeSchema>;
export type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
export type SessionMessagePartDeltaEntry = Extract<SessionEntry, { type: "message_part_delta" }>;
export type SessionMetaEntry = Extract<SessionEntry, { type: "session_meta" }>;
export type SessionMessageV2Entry = Extract<SessionEntry, { type: "message_v2" }>;
export type SessionPermissionRuleAction = z.infer<typeof sessionPermissionRuleActionSchema>;
export type SessionPermissionRuleEntry = Extract<SessionEntry, { type: "permission_rule" }>;
export type SessionMessageRole = z.infer<typeof sessionMessageRoleSchema>;
export type SessionPendingActionEntry = Extract<SessionEntry, { type: "pending_action" }>;
export type SessionPendingActionKind = z.infer<typeof sessionPendingActionKindSchema>;
export type SessionPendingActionStatus = z.infer<typeof sessionPendingActionStatusSchema>;
export type SessionRunEventEntry = Extract<SessionEntry, { type: "run_event" }>;
export type SessionRunEventPhase = z.infer<typeof sessionRunEventPhaseSchema>;
export type SessionMessageWrite = {
  content: string;
  role: SessionMessageRole;
  timestamp?: string;
};

export type SessionMessageV2Write = {
  message: z.infer<typeof messageV2Schema>;
  timestamp?: string;
};

export type SessionMessagePartDeltaWrite = {
  delta: unknown;
  messageId: string;
  partId: string;
  timestamp?: string;
};

export type SessionMetaTitleWrite = {
  timestamp?: string;
  title: string;
};
export type SessionApprovalRuleWrite = {
  decision: SessionApprovalRuleDecision;
  pattern: string;
  scope: SessionApprovalRuleScope;
  timestamp?: string;
};

export type SessionPermissionRuleWrite = {
  action: SessionPermissionRuleAction;
  pattern: string;
  permission: string;
  scope: SessionApprovalRuleScope;
  timestamp?: string;
};
export type SessionPendingActionWrite = {
  context?: Record<string, unknown>;
  kind: SessionPendingActionKind;
  prompt: string;
  runId: string;
  sessionId: string;
  status: SessionPendingActionStatus;
  timestamp?: string;
};
export type SessionRunEventWrite = {
  event: string;
  payload?: Record<string, unknown>;
  phase: SessionRunEventPhase;
  runId: string;
  step: number;
  timestamp?: string;
};

export type SessionCatalogItem = {
  firstUserMessage?: string;
  lastInteractedAgo: string;
  lastInteractedAt: string;
  sessionFilePath: string;
  sessionId: string;
  title?: string;
};

export type SessionCatalogMetadata = z.infer<typeof sessionCatalogMetadataSchema>;

const SESSION_FILENAME_REGEX = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.jsonl$/u;
const RELATIVE_TIME_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const RELATIVE_TIME_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const RELATIVE_TIME_DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_TIME_HOUR_MS = 60 * 60 * 1000;
const RELATIVE_TIME_MINUTE_MS = 60 * 1000;

function sessionIdToPath(sessionId: string): string {
  return join(SESSIONS_DIRECTORY_PATH, `${sessionId}.jsonl`);
}

function sessionIdToMetadataPath(sessionId: string): string {
  return join(SESSIONS_DIRECTORY_PATH, `${sessionId}.meta.json`);
}

export function normalizeSessionId(rawSessionId: string): string {
  const sessionId = rawSessionId.trim();
  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new Error(
      `Invalid session id: "${rawSessionId}". Use 1-64 chars from A-Z, a-z, 0-9, "_" or "-".`
    );
  }

  return sessionId;
}

export function getSessionFilePath(sessionId: string): string {
  return sessionIdToPath(normalizeSessionId(sessionId));
}

export async function readSessionCatalogMetadata(
  sessionId: string
): Promise<SessionCatalogMetadata | undefined> {
  const path = sessionIdToMetadataPath(normalizeSessionId(sessionId));

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  const validated = sessionCatalogMetadataSchema.safeParse(parsed);
  if (!validated.success) {
    return undefined;
  }

  const normalizedTitle = validated.data.title?.trim();
  if (!normalizedTitle) {
    return undefined;
  }

  return {
    title: normalizedTitle,
  };
}

export async function writeSessionCatalogMetadata(
  sessionId: string,
  metadata: SessionCatalogMetadata
): Promise<void> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const path = sessionIdToMetadataPath(normalizedSessionId);
  const normalizedTitle = metadata.title?.trim();

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(normalizedTitle ? { title: normalizedTitle } : {})}\n`,
    "utf8"
  );
}

export async function readSessionEntries(sessionId: string): Promise<SessionEntry[]> {
  const path = sessionIdToPath(normalizeSessionId(sessionId));

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const entries: SessionEntry[] = [];
  const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON in session file at line ${String(index + 1)}: ${error instanceof Error ? error.message : "Unknown parse error"}`
      );
    }

    const validated = sessionEntrySchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `Invalid session entry at line ${String(index + 1)}: ${validated.error.message}`
      );
    }

    entries.push(validated.data);
  }

  return entries;
}

export async function appendSessionEntries(
  sessionId: string,
  entries: SessionEntry[]
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const normalizedSessionId = normalizeSessionId(sessionId);
  const path = sessionIdToPath(normalizedSessionId);

  await mkdir(dirname(path), { recursive: true });

  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await appendFile(path, `${payload}\n`, "utf8");
}

export async function appendSessionMessage(
  sessionId: string,
  message: SessionMessageWrite
): Promise<void> {
  const timestamp = message.timestamp ?? new Date().toISOString();
  await appendSessionEntries(sessionId, [
    {
      content: message.content,
      role: message.role,
      timestamp,
      type: "message",
    },
  ]);
}

export async function appendSessionMessageV2(
  sessionId: string,
  message: SessionMessageV2Write
): Promise<void> {
  const timestamp = message.timestamp ?? new Date().toISOString();
  await appendSessionEntries(sessionId, [
    {
      message: message.message,
      timestamp,
      type: "message_v2",
    },
  ]);
}

export async function appendSessionMessagePartDelta(
  sessionId: string,
  delta: SessionMessagePartDeltaWrite
): Promise<void> {
  const timestamp = delta.timestamp ?? new Date().toISOString();
  await appendSessionEntries(sessionId, [
    {
      delta: delta.delta,
      messageId: delta.messageId,
      partId: delta.partId,
      timestamp,
      type: "message_part_delta",
    },
  ]);
}

export async function appendSessionMetaTitle(
  sessionId: string,
  meta: SessionMetaTitleWrite
): Promise<void> {
  const normalizedTitle = meta.title.trim();
  if (normalizedTitle.length === 0) {
    return;
  }

  const timestamp = meta.timestamp ?? new Date().toISOString();
  await appendSessionEntries(sessionId, [
    {
      timestamp,
      title: normalizedTitle,
      type: "session_meta",
    },
  ]);
  await writeSessionCatalogMetadata(sessionId, { title: normalizedTitle });
}

export async function appendSessionRunEvent(
  sessionId: string,
  event: SessionRunEventWrite
): Promise<void> {
  const timestamp = event.timestamp ?? new Date().toISOString();
  await appendSessionEntries(sessionId, [
    {
      event: event.event,
      payload: event.payload ?? {},
      phase: event.phase,
      runId: event.runId,
      step: event.step,
      timestamp,
      type: "run_event",
    },
  ]);
}

export async function appendSessionPendingAction(
  sessionId: string,
  pendingAction: SessionPendingActionWrite
): Promise<void> {
  const timestamp = pendingAction.timestamp ?? new Date().toISOString();
  await appendSessionEntries(sessionId, [
    {
      context: pendingAction.context ?? {},
      kind: pendingAction.kind,
      prompt: pendingAction.prompt,
      runId: pendingAction.runId,
      sessionId: pendingAction.sessionId,
      status: pendingAction.status,
      timestamp,
      type: "pending_action",
    },
  ]);
}

export async function appendSessionApprovalRule(
  sessionId: string,
  rule: SessionApprovalRuleWrite
): Promise<void> {
  const timestamp = rule.timestamp ?? new Date().toISOString();
  await appendSessionEntries(sessionId, [
    {
      decision: rule.decision,
      pattern: rule.pattern,
      scope: rule.scope,
      timestamp,
      type: "approval_rule",
    },
  ]);
}

export async function appendSessionPermissionRule(
  sessionId: string,
  rule: SessionPermissionRuleWrite
): Promise<void> {
  const timestamp = rule.timestamp ?? new Date().toISOString();
  await appendSessionEntries(sessionId, [
    {
      action: rule.action,
      pattern: rule.pattern,
      permission: rule.permission,
      scope: rule.scope,
      timestamp,
      type: "permission_rule",
    },
  ]);
}

function resolvePendingActionId(action: SessionPendingActionEntry): string {
  const pendingId = action.context.pendingId;
  if (typeof pendingId === "string" && pendingId.length > 0) {
    return pendingId;
  }

  return `${action.runId}:${action.kind}:${action.prompt}`;
}

export function findLatestOpenPendingAction(
  entries: SessionEntry[],
  kind?: SessionPendingActionKind
): SessionPendingActionEntry | undefined {
  const openActions = new Map<string, SessionPendingActionEntry>();

  for (const entry of entries) {
    if (entry.type !== "pending_action") {
      continue;
    }
    if (kind && entry.kind !== kind) {
      continue;
    }

    const pendingId = resolvePendingActionId(entry);
    if (entry.status === "resolved") {
      openActions.delete(pendingId);
      continue;
    }

    openActions.set(pendingId, entry);
  }

  const candidates = Array.from(openActions.values());
  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return candidates[candidates.length - 1];
}

export async function readSessionMessages(sessionId: string): Promise<SessionMessageEntry[]> {
  const entries = await readSessionEntries(sessionId);
  return entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
}

export function formatRelativeSessionTime(lastInteractedAtIso: string, now: Date = new Date()): string {
  const timestamp = Date.parse(lastInteractedAtIso);
  if (!Number.isFinite(timestamp)) {
    return "just now";
  }

  const deltaMs = Math.max(0, now.getTime() - timestamp);
  if (deltaMs < RELATIVE_TIME_MINUTE_MS) {
    return "just now";
  }
  if (deltaMs < RELATIVE_TIME_HOUR_MS) {
    return `${String(Math.floor(deltaMs / RELATIVE_TIME_MINUTE_MS))}m ago`;
  }
  if (deltaMs < RELATIVE_TIME_DAY_MS) {
    return `${String(Math.floor(deltaMs / RELATIVE_TIME_HOUR_MS))}h ago`;
  }
  if (deltaMs < RELATIVE_TIME_MONTH_MS) {
    return `${String(Math.floor(deltaMs / RELATIVE_TIME_DAY_MS))}d ago`;
  }
  if (deltaMs < RELATIVE_TIME_YEAR_MS) {
    return `${String(Math.floor(deltaMs / RELATIVE_TIME_MONTH_MS))}mo ago`;
  }
  return `${String(Math.floor(deltaMs / RELATIVE_TIME_YEAR_MS))}y ago`;
}

export async function listSessionCatalog(input?: { now?: Date }): Promise<SessionCatalogItem[]> {
  let filenames: string[];
  try {
    filenames = await readdir(SESSIONS_DIRECTORY_PATH);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const now = input?.now ?? new Date();
  const catalog: Array<SessionCatalogItem & { lastInteractedAtMs: number }> = [];

  for (const filename of filenames) {
    const matched = filename.match(SESSION_FILENAME_REGEX);
    if (!matched) {
      continue;
    }

    const sessionId = matched[1];
    if (!sessionId) {
      continue;
    }
    const sessionFilePath = join(SESSIONS_DIRECTORY_PATH, filename);
    let fileStat;
    try {
      fileStat = await stat(sessionFilePath);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) {
      continue;
    }

    let metadata: SessionCatalogMetadata | undefined;
    try {
      metadata = await readSessionCatalogMetadata(sessionId);
    } catch {
      metadata = undefined;
    }

    const lastInteractedAt = fileStat.mtime.toISOString();
    catalog.push({
      lastInteractedAgo: formatRelativeSessionTime(lastInteractedAt, now),
      lastInteractedAt,
      lastInteractedAtMs: fileStat.mtimeMs,
      sessionFilePath,
      sessionId,
      title: metadata?.title,
    });
  }

  catalog.sort((left, right) => right.lastInteractedAtMs - left.lastInteractedAtMs);
  return catalog.map(({ lastInteractedAtMs: _lastInteractedAtMs, ...item }) => item);
}
