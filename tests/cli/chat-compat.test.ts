import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import { createAutoSessionId, loadSessionState } from "../../src/cli/chat-session";
import { appendSessionEntries, getSessionFilePath, readSessionEntries } from "../../src/tools/session";

describe("chat session compatibility", () => {
  test("legacy session entries load without requiring new entry types", async () => {
    const sessionId = createAutoSessionId(new Date("2026-02-17T19:00:00.000Z"));
    const sessionPath = getSessionFilePath(sessionId);

    try {
      await appendSessionEntries(sessionId, [
        {
          content: "hello",
          role: "user",
          timestamp: "2026-02-17T19:00:00.000Z",
          type: "message",
        },
        {
          content: "hi there",
          role: "assistant",
          timestamp: "2026-02-17T19:00:01.000Z",
          type: "message",
        },
        {
          assistantMessage: "I need a concrete task.",
          durationMs: 1200,
          endedAt: "2026-02-17T19:00:02.000Z",
          finalState: "waiting_for_user",
          sessionId,
          startedAt: "2026-02-17T19:00:01.000Z",
          steps: 1,
          success: false,
          summary: "Need concrete task",
          task: "hello",
          type: "run",
          userMessage: "hello",
        },
      ]);

      const entries = await readSessionEntries(sessionId);
      expect(entries.length).toBe(3);

      const loadedState = await loadSessionState(sessionId, 3_600_000);
      expect(loadedState.turns.length).toBe(1);
      expect(loadedState.pendingApproval).toBeUndefined();
      expect(loadedState.pendingFollowUpQuestion).toBe("I need a concrete task.");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });
});
