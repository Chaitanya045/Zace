import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import type { AgentResult } from "../../src/agent/loop";

import { createAutoSessionId, persistSessionTurn, resolveSessionId } from "../../src/cli/chat-session";
import { appendSessionMessage, getSessionFilePath, readSessionEntries } from "../../src/tools/session";

function createTestSessionId(): string {
  return createAutoSessionId(new Date());
}

describe("chat session", () => {
  test("auto session id is valid and normalizable", () => {
    const sessionId = createAutoSessionId(new Date("2026-02-16T10:11:12.000Z"));
    expect(sessionId).toMatch(/^chat-\d{8}-\d{6}-[a-z0-9]{6}$/u);
    expect(resolveSessionId(sessionId)).toBe(sessionId);
  });

  test("session journaling persists messages and run metadata", async () => {
    const sessionId = createTestSessionId();
    const sessionPath = getSessionFilePath(sessionId);
    const startedAt = new Date("2026-02-16T10:00:00.000Z");
    const endedAt = new Date("2026-02-16T10:00:02.000Z");

    try {
      await appendSessionMessage(sessionId, {
        content: "User says hello",
        role: "user",
        timestamp: "2026-02-16T10:00:00.000Z",
      });
      await appendSessionMessage(sessionId, {
        content: "Assistant replies hello",
        role: "assistant",
        timestamp: "2026-02-16T10:00:01.000Z",
      });

      const result: AgentResult = {
        context: {
          currentStep: 1,
          fileSummaries: new Map<string, string>(),
          maxSteps: 5,
          scriptCatalog: new Map(),
          steps: [],
          task: "test task",
        },
        finalState: "completed",
        message: "done",
        success: true,
      };

      await persistSessionTurn(
        sessionId,
        "User says hello",
        "test task",
        result,
        startedAt,
        endedAt
      );

      const entries = await readSessionEntries(sessionId);
      expect(entries.filter((entry) => entry.type === "message").length).toBe(2);
      expect(entries.filter((entry) => entry.type === "summary").length).toBe(1);
      expect(entries.filter((entry) => entry.type === "run").length).toBe(1);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });
});
