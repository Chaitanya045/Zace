import { z } from "zod";

import type { LlmClient } from "../llm/client";
import type { SessionCatalogItem } from "../tools/session";

import { buildSessionTitlePrompt, SESSION_TITLE_SYSTEM_PROMPT } from "../prompts/session-title";
import { appendSessionMetaTitle } from "../tools/session";

const DEFAULT_TITLE_CHUNK_SIZE = 12;
const FIRST_MESSAGE_PROMPT_LIMIT_CHARS = 240;
const SESSION_TITLE_MAX_CHARS = 60;
const SESSION_FALLBACK_TITLE_MAX_CHARS = 48;

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
  client: Pick<LlmClient, "chat">;
  sessions: Array<{
    firstUserMessage: string;
    sessionId: string;
  }>;
}): Promise<Map<string, string>> {
  const response = await input.client.chat({
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
  });

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
