import { randomUUID } from "node:crypto";

import type { AgentResult } from "../agent/loop";

import {
  appendSessionEntries,
  normalizeSessionId,
  readSessionEntries,
} from "../tools/session";

export type ChatTurn = {
  assistant: string;
  finalState: string;
  steps: number;
  user: string;
};

export type SessionState = {
  pendingFollowUpQuestion?: string;
  turns: ChatTurn[];
};

const MAX_CHAT_CONTEXT_TURNS = 6;

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function createAutoSessionId(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = padDatePart(now.getMonth() + 1);
  const day = padDatePart(now.getDate());
  const hour = padDatePart(now.getHours());
  const minute = padDatePart(now.getMinutes());
  const second = padDatePart(now.getSeconds());
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 6);

  return normalizeSessionId(`chat-${year}${month}${day}-${hour}${minute}${second}-${suffix}`);
}

export function resolveSessionId(rawSessionId?: string): string | undefined {
  if (!rawSessionId) {
    return undefined;
  }

  return normalizeSessionId(rawSessionId);
}

export function resolveOrCreateSessionId(rawSessionId?: string): string {
  const resolved = resolveSessionId(rawSessionId);
  if (resolved) {
    return resolved;
  }

  return createAutoSessionId();
}

export function buildChatTaskWithFollowUp(
  turns: ChatTurn[],
  userInput: string,
  followUpQuestion?: string
): string {
  const recentTurns = turns.slice(-MAX_CHAT_CONTEXT_TURNS);
  if (recentTurns.length === 0 && !followUpQuestion) {
    return userInput;
  }

  const history = recentTurns
    .map(
      (turn, index) =>
        `Turn ${index + 1}\nUser: ${turn.user}\nAssistant: ${turn.assistant}\nState: ${turn.finalState}`
    )
    .join("\n\n");

  const followUpContext = followUpQuestion
    ? `\n\nAGENT FOLLOW-UP QUESTION:\n${followUpQuestion}\n\nUSER FOLLOW-UP ANSWER:\n${userInput}`
    : `\n\nCURRENT USER MESSAGE:\n${userInput}`;

  return `Continue this interactive conversation using the recent context.

RECENT CONVERSATION:
${history}
${followUpContext}`;
}

export async function loadSessionState(sessionId: string): Promise<SessionState> {
  const entries = await readSessionEntries(sessionId);
  const turns = entries
    .filter((entry) => entry.type === "run")
    .map((entry) => ({
      assistant: entry.assistantMessage,
      finalState: entry.finalState,
      steps: entry.steps,
      user: entry.userMessage,
    }));

  const lastTurn = turns[turns.length - 1];
  return {
    pendingFollowUpQuestion:
      lastTurn?.finalState === "waiting_for_user" ? lastTurn.assistant : undefined,
    turns,
  };
}

export async function persistSessionTurn(
  sessionId: string,
  userMessage: string,
  task: string,
  result: AgentResult,
  startedAt: Date,
  endedAt: Date
): Promise<void> {
  const startedAtIso = startedAt.toISOString();
  const endedAtIso = endedAt.toISOString();
  const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
  const summary = result.message;

  await appendSessionEntries(sessionId, [
    {
      finalState: result.finalState,
      success: result.success,
      summary,
      timestamp: endedAtIso,
      type: "summary",
    },
    {
      assistantMessage: result.message,
      durationMs,
      endedAt: endedAtIso,
      finalState: result.finalState,
      sessionId,
      startedAt: startedAtIso,
      steps: result.context.steps.length,
      success: result.success,
      summary,
      task,
      type: "run",
      userMessage,
    },
  ]);
}
