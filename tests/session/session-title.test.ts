import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backfillMissingSessionTitles, sanitizeSessionTitle } from "../../src/session/session-title";
import { appendSessionEntries, readSessionEntries } from "../../src/tools/session";

describe("session title generation", () => {
  test("backfills missing titles and persists session_meta entries", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-title-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(baseDir);
      await appendSessionEntries("session-one", [
        {
          assistantMessage: "Assistant response",
          durationMs: 1000,
          endedAt: new Date("2026-03-04T11:00:01.000Z").toISOString(),
          finalState: "waiting_for_user",
          sessionId: "session-one",
          startedAt: new Date("2026-03-04T11:00:00.000Z").toISOString(),
          steps: 1,
          success: false,
          summary: "Need clarification",
          task: "task",
          type: "run",
          userMessage: "please fix login bug in auth middleware",
        },
      ]);

      const titled = await backfillMissingSessionTitles({
        client: {
          chat: async () => ({
            content:
              '{"titles":[{"sessionId":"session-one","title":"Fix auth middleware login bug"}]}',
          }),
        },
        sessions: [
          {
            firstUserMessage: "please fix login bug in auth middleware",
            lastInteractedAgo: "1h ago",
            lastInteractedAt: new Date("2026-03-04T11:00:00.000Z").toISOString(),
            sessionFilePath: ".zace/sessions/session-one.jsonl",
            sessionId: "session-one",
          },
        ],
      });

      expect(titled[0]?.title).toBe("Fix auth middleware login bug");

      const entries = await readSessionEntries("session-one");
      const metaEntries = entries.filter((entry) => entry.type === "session_meta");
      expect(metaEntries.length).toBe(1);
      expect(metaEntries[0]?.type).toBe("session_meta");
      if (metaEntries[0]?.type === "session_meta") {
        expect(metaEntries[0].title).toBe("Fix auth middleware login bug");
      }
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("falls back to first user message when llm title generation fails", async () => {
    const titled = await backfillMissingSessionTitles({
      client: {
        chat: async () => {
          throw new Error("provider failed");
        },
      },
      sessions: [
        {
          firstUserMessage:
            "investigate flaky websocket reconnect handling in the notification dispatcher",
          lastInteractedAgo: "2d ago",
          lastInteractedAt: new Date("2026-03-02T11:00:00.000Z").toISOString(),
          sessionFilePath: ".zace/sessions/fallback-session.jsonl",
          sessionId: "fallback-session",
        },
      ],
    });

    expect(titled[0]?.title).toBe(
      "investigate flaky websocket reconnect handlin..."
    );
  });

  test("sanitizeSessionTitle trims quotes and enforces max width", () => {
    const sanitized = sanitizeSessionTitle(
      '"This is a very long title that should be truncated because it exceeds the maximum width allowed"'
    );
    expect(sanitized).toBe(
      "This is a very long title that should be truncated becaus..."
    );
  });
});
