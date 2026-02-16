import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

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

export const sessionEntrySchema = z.discriminatedUnion("type", [
  sessionMessageEntrySchema,
  sessionSummaryEntrySchema,
  sessionRunEntrySchema,
]);

export type SessionEntry = z.infer<typeof sessionEntrySchema>;
export type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
export type SessionMessageRole = z.infer<typeof sessionMessageRoleSchema>;
export type SessionMessageWrite = {
  content: string;
  role: SessionMessageRole;
  timestamp?: string;
};

function sessionIdToPath(sessionId: string): string {
  return join(SESSIONS_DIRECTORY_PATH, `${sessionId}.jsonl`);
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

export async function readSessionMessages(sessionId: string): Promise<SessionMessageEntry[]> {
  const entries = await readSessionEntries(sessionId);
  return entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
}
