import { z } from "zod";

import type { LlmClient } from "../llm/client";
import type { SessionCatalogItem } from "../tools/session";

import { buildSessionTitlePrompt, SESSION_TITLE_SYSTEM_PROMPT } from "../prompts/session-title";
import { appendSessionMetaTitle } from "../tools/session";
import { logError } from "../utils/logger";

const DEFAULT_TITLE_CHUNK_SIZE = 12;
const FIRST_MESSAGE_PROMPT_LIMIT_CHARS = 240;
const SESSION_TITLE_BACKGROUND_MAX_ATTEMPTS = 2;
const SESSION_TITLE_BACKGROUND_RETRY_DELAY_MS = 250;
const SESSION_TITLE_BACKGROUND_TIMEOUT_MS = 12_000;
const SESSION_TITLE_MAX_CHARS = 60;
const SESSION_FALLBACK_TITLE_MAX_CHARS = 48;
const titleGenerationJobsBySessionId = new Map<string, Promise<void>>();

const sessionTitleResponseSchema = z.object({
  titles: z.array(
    z.object({
      sessionId: z.string().min(1),
      title: z.string().min(1),
    })
  ),
});

function parseJsonPayload(content: string): null | unknown {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Keep trying fallback extraction.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch {
      // Keep trying fallback extraction.
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/u);
  if (objectMatch?.[0]) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function truncateWithEllipsis(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, Math.max(0, maxChars));
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function sanitizeSessionTitle(rawTitle: string): string {
  const normalized = normalizeWhitespace(rawTitle).replace(/^["']+|["']+$/gu, "");
  return truncateWithEllipsis(normalized, SESSION_TITLE_MAX_CHARS);
}

export function buildFallbackSessionTitle(firstUserMessage: string | undefined, sessionId: string): string {
  if (!firstUserMessage || firstUserMessage.trim().length === 0) {
    return `Session ${sessionId}`;
  }

  return truncateWithEllipsis(normalizeWhitespace(firstUserMessage), SESSION_FALLBACK_TITLE_MAX_CHARS);
}

export async function assignSessionTitleFromFirstUserMessage(input: {
  abortSignal?: globalThis.AbortSignal;
  client: Pick<LlmClient, "chat">;
  sessionId: string;
  userMessage: string;
}): Promise<string> {
  const fallbackTitle = buildFallbackSessionTitle(input.userMessage, input.sessionId);
  let resolvedTitle = fallbackTitle;

  try {
    resolvedTitle = await generateTitleFromFirstUserMessage({
      abortSignal: input.abortSignal,
      client: input.client,
      sessionId: input.sessionId,
      userMessage: input.userMessage,
    });
  } catch {
    resolvedTitle = fallbackTitle;
  }

  try {
    await appendSessionMetaTitle(input.sessionId, { title: resolvedTitle });
  } catch {
    // Keep turn processing resilient even if title persistence fails.
  }

  return resolvedTitle;
}

async function generateTitleFromFirstUserMessage(input: {
  abortSignal?: globalThis.AbortSignal;
  client: Pick<LlmClient, "chat">;
  sessionId: string;
  userMessage: string;
}): Promise<string> {
  const generated = await generateSessionTitlesForChunk({
    abortSignal: input.abortSignal,
    client: input.client,
    sessions: [
      {
        firstUserMessage: input.userMessage,
        sessionId: input.sessionId,
      },
    ],
  });
  const generatedTitle = generated.get(input.sessionId);
  if (!generatedTitle || generatedTitle.trim().length === 0) {
    throw new Error("Session title generation returned no title.");
  }

  return generatedTitle;
}

export function scheduleSessionTitleFromFirstUserMessage(input: {
  client: Pick<LlmClient, "chat">;
  sessionId: string;
  userMessage: string;
}): Promise<void> {
  const existing = titleGenerationJobsBySessionId.get(input.sessionId);
  if (existing) {
    return existing;
  }

  const job = (async () => {
    const fallbackTitle = buildFallbackSessionTitle(input.userMessage, input.sessionId);
    let resolvedTitle = fallbackTitle;
    let generatedTitle = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= SESSION_TITLE_BACKGROUND_MAX_ATTEMPTS; attempt += 1) {
      try {
        resolvedTitle = await generateTitleFromFirstUserMessage({
          abortSignal: globalThis.AbortSignal.timeout(SESSION_TITLE_BACKGROUND_TIMEOUT_MS),
          client: input.client,
          sessionId: input.sessionId,
          userMessage: input.userMessage,
        });
        generatedTitle = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < SESSION_TITLE_BACKGROUND_MAX_ATTEMPTS) {
          await sleep(SESSION_TITLE_BACKGROUND_RETRY_DELAY_MS);
        }
      }
    }

    try {
      await appendSessionMetaTitle(input.sessionId, { title: resolvedTitle });
    } catch (error) {
      if (generatedTitle) {
        logError(
          `Background session title persistence failed for session ${input.sessionId}.`,
          error
        );
      } else {
        lastError = lastError ?? error;
      }
    }

    if (!generatedTitle && lastError) {
      logError(
        `Background session title generation failed for session ${input.sessionId}; persisted fallback title.`,
        lastError
      );
    }
  })()
    .catch((error) => {
      logError(
        `Unexpected background session title scheduling failure for session ${input.sessionId}.`,
        error
      );
    })
    .finally(() => {
      titleGenerationJobsBySessionId.delete(input.sessionId);
    });

  titleGenerationJobsBySessionId.set(input.sessionId, job);
  return job;
}

function chunkBySize<T>(values: T[], size: number): T[][] {
  if (values.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function generateSessionTitlesForChunk(input: {
  abortSignal?: globalThis.AbortSignal;
  client: Pick<LlmClient, "chat">;
  sessions: Array<{
    firstUserMessage: string;
    sessionId: string;
  }>;
}): Promise<Map<string, string>> {
  const response = await input.client.chat(
    {
      callKind: "planner",
      messages: [
        {
          content: SESSION_TITLE_SYSTEM_PROMPT,
          role: "system",
        },
        {
          content: buildSessionTitlePrompt({
            sessions: input.sessions.map((session) => ({
              firstUserMessage: truncateWithEllipsis(
                normalizeWhitespace(session.firstUserMessage),
                FIRST_MESSAGE_PROMPT_LIMIT_CHARS
              ),
              sessionId: session.sessionId,
            })),
          }),
          role: "user",
        },
      ],
    },
    input.abortSignal
      ? {
          abortSignal: input.abortSignal,
        }
      : undefined
  );

  const parsed = parseJsonPayload(response.content);
  if (!parsed) {
    return new Map();
  }

  const validated = sessionTitleResponseSchema.safeParse(parsed);
  if (!validated.success) {
    return new Map();
  }

  const allowedSessionIds = new Set(input.sessions.map((session) => session.sessionId));
  const resolved = new Map<string, string>();
  for (const title of validated.data.titles) {
    if (!allowedSessionIds.has(title.sessionId)) {
      continue;
    }
    const sanitized = sanitizeSessionTitle(title.title);
    if (!sanitized) {
      continue;
    }
    resolved.set(title.sessionId, sanitized);
  }
  return resolved;
}

export async function backfillMissingSessionTitles(input: {
  chunkSize?: number;
  client: Pick<LlmClient, "chat">;
  sessions: SessionCatalogItem[];
}): Promise<SessionCatalogItem[]> {
  const chunkSize = Math.max(1, Math.trunc(input.chunkSize ?? DEFAULT_TITLE_CHUNK_SIZE));
  const sessions = input.sessions.map((session) => ({ ...session }));
  const untitledSessions = sessions.filter(
    (session) =>
      (!session.title || session.title.trim().length === 0) &&
      typeof session.firstUserMessage === "string" &&
      session.firstUserMessage.trim().length > 0
  );

  const generatedTitlesBySessionId = new Map<string, string>();
  for (const chunk of chunkBySize(untitledSessions, chunkSize)) {
    let generatedForChunk: Map<string, string>;
    try {
      generatedForChunk = await generateSessionTitlesForChunk({
        client: input.client,
        sessions: chunk
          .filter(
            (session): session is SessionCatalogItem & { firstUserMessage: string } =>
              typeof session.firstUserMessage === "string" && session.firstUserMessage.trim().length > 0
          )
          .map((session) => ({
            firstUserMessage: session.firstUserMessage,
            sessionId: session.sessionId,
          })),
      });
    } catch {
      continue;
    }

    for (const [sessionId, title] of generatedForChunk.entries()) {
      generatedTitlesBySessionId.set(sessionId, title);
      try {
        await appendSessionMetaTitle(sessionId, { title });
      } catch {
        // Keep list behavior resilient even if persistence fails.
      }
    }
  }

  return sessions.map((session) => {
    const generatedTitle = generatedTitlesBySessionId.get(session.sessionId);
    if (generatedTitle) {
      return {
        ...session,
        title: generatedTitle,
      };
    }

    if (session.title && session.title.trim().length > 0) {
      return {
        ...session,
        title: sanitizeSessionTitle(session.title),
      };
    }

    return {
      ...session,
      title: buildFallbackSessionTitle(session.firstUserMessage, session.sessionId),
    };
  });
}
