import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assignSessionTitleFromFirstUserMessage,
  backfillMissingSessionTitles,
  scheduleSessionTitleFromFirstUserMessage,
  sanitizeSessionTitle,
} from "../../src/session/session-title";
import { appendSessionEntries, readSessionCatalogMetadata, readSessionEntries } from "../../src/tools/session";

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
      const metadata = await readSessionCatalogMetadata("session-one");
      expect(metadata?.title).toBe("Fix auth middleware login bug");
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("assigns first-turn session title from llm and persists metadata", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-title-assign-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(baseDir);
      await appendSessionEntries("fresh-session", [
        {
          assistantMessage: "Assistant response",
          durationMs: 1200,
          endedAt: new Date("2026-03-04T11:00:01.000Z").toISOString(),
          finalState: "completed",
          sessionId: "fresh-session",
          startedAt: new Date("2026-03-04T11:00:00.000Z").toISOString(),
          steps: 2,
          success: true,
          summary: "done",
          task: "task",
          type: "run",
          userMessage: "add caching to switch session listing",
        },
      ]);

      const title = await assignSessionTitleFromFirstUserMessage({
        client: {
          chat: async () => ({
            content:
              '{"titles":[{"sessionId":"fresh-session","title":"Add caching for session list"}]}',
          }),
        },
        sessionId: "fresh-session",
        userMessage: "add caching to switch session listing",
      });

      expect(title).toBe("Add caching for session list");
      const metadata = await readSessionCatalogMetadata("fresh-session");
      expect(metadata?.title).toBe("Add caching for session list");
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("falls back to deterministic title when first-turn llm title fails", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-title-fallback-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(baseDir);
      await appendSessionEntries("fallback-first-turn", [
        {
          assistantMessage: "Assistant response",
          durationMs: 1200,
          endedAt: new Date("2026-03-04T11:00:01.000Z").toISOString(),
          finalState: "completed",
          sessionId: "fallback-first-turn",
          startedAt: new Date("2026-03-04T11:00:00.000Z").toISOString(),
          steps: 2,
          success: true,
          summary: "done",
          task: "task",
          type: "run",
          userMessage: "investigate flaky websocket reconnect handling in the notification dispatcher",
        },
      ]);

      const title = await assignSessionTitleFromFirstUserMessage({
        client: {
          chat: async () => {
            throw new Error("provider failed");
          },
        },
        sessionId: "fallback-first-turn",
        userMessage: "investigate flaky websocket reconnect handling in the notification dispatcher",
      });

      expect(title).toBe("investigate flaky websocket reconnect handlin...");
      const metadata = await readSessionCatalogMetadata("fallback-first-turn");
      expect(metadata?.title).toBe("investigate flaky websocket reconnect handlin...");
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("schedules first-turn title generation in background with per-session dedupe", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-title-schedule-dedupe-"));
    const originalCwd = process.cwd();
    let chatCalls = 0;

    try {
      process.chdir(baseDir);

      const firstJob = scheduleSessionTitleFromFirstUserMessage({
        client: {
          chat: async () => {
            chatCalls += 1;
            await new Promise((resolve) => {
              setTimeout(resolve, 30);
            });
            return {
              content:
                '{"titles":[{"sessionId":"scheduled-dedupe","title":"Background generated title"}]}',
            };
          },
        },
        sessionId: "scheduled-dedupe",
        userMessage: "optimize switch session loading performance",
      });
      const secondJob = scheduleSessionTitleFromFirstUserMessage({
        client: {
          chat: async () => {
            throw new Error("unexpected duplicate call");
          },
        },
        sessionId: "scheduled-dedupe",
        userMessage: "optimize switch session loading performance",
      });

      await Promise.all([firstJob, secondJob]);
      expect(chatCalls).toBe(1);
      const metadata = await readSessionCatalogMetadata("scheduled-dedupe");
      expect(metadata?.title).toBe("Background generated title");
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("retries background first-turn title generation and persists success", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-title-schedule-retry-"));
    const originalCwd = process.cwd();
    let chatCalls = 0;

    try {
      process.chdir(baseDir);

      await scheduleSessionTitleFromFirstUserMessage({
        client: {
          chat: async () => {
            chatCalls += 1;
            if (chatCalls === 1) {
              throw new Error("transient provider issue");
            }
            return {
              content:
                '{"titles":[{"sessionId":"scheduled-retry","title":"Recovered title after retry"}]}',
            };
          },
        },
        sessionId: "scheduled-retry",
        userMessage: "fix interrupted run recovery validation flow",
      });

      expect(chatCalls).toBe(2);
      const metadata = await readSessionCatalogMetadata("scheduled-retry");
      expect(metadata?.title).toBe("Recovered title after retry");
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("persists fallback title when background generation exhausts retries", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-title-schedule-fallback-"));
    const originalCwd = process.cwd();
    let chatCalls = 0;

    try {
      process.chdir(baseDir);

      await scheduleSessionTitleFromFirstUserMessage({
        client: {
          chat: async () => {
            chatCalls += 1;
            throw new Error("provider unavailable");
          },
        },
        sessionId: "scheduled-fallback",
        userMessage: "investigate flaky websocket reconnect handling in the notification dispatcher",
      });

      expect(chatCalls).toBe(2);
      const metadata = await readSessionCatalogMetadata("scheduled-fallback");
      expect(metadata?.title).toBe("investigate flaky websocket reconnect handlin...");
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
