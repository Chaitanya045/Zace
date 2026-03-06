import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendSessionEntries,
  appendSessionMetaTitle,
  formatRelativeSessionTime,
  getSessionFilePath,
  listSessionCatalog,
} from "../../src/tools/session";

describe("session catalog", () => {
  test("lists sessions only from current working directory", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-catalog-"));
    const dir1 = join(baseDir, "dir1");
    const dir2 = join(baseDir, "dir2");
    const originalCwd = process.cwd();

    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    try {
      process.chdir(dir1);
      await appendSessionEntries("dir1-session", [
        {
          content: "hello from dir1",
          role: "user",
          timestamp: new Date("2026-03-04T08:00:00.000Z").toISOString(),
          type: "message",
        },
      ]);

      process.chdir(dir2);
      await appendSessionEntries("dir2-session", [
        {
          content: "hello from dir2",
          role: "user",
          timestamp: new Date("2026-03-04T08:05:00.000Z").toISOString(),
          type: "message",
        },
      ]);

      process.chdir(dir1);
      const catalog = await listSessionCatalog({
        now: new Date("2026-03-04T09:00:00.000Z"),
      });

      expect(catalog.length).toBe(1);
      expect(catalog[0]?.sessionId).toBe("dir1-session");
      expect(catalog[0]?.sessionFilePath).toBe(".zace/sessions/dir1-session.jsonl");
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("sorts sessions by recency and computes compact relative time", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-sort-"));
    const originalCwd = process.cwd();
    const now = new Date("2026-03-04T12:00:00.000Z");

    try {
      process.chdir(baseDir);

      await appendSessionEntries("older-session", [
        {
          assistantMessage: "Older assistant reply",
          durationMs: 900,
          endedAt: new Date("2026-03-02T11:59:00.000Z").toISOString(),
          finalState: "completed",
          sessionId: "older-session",
          startedAt: new Date("2026-03-02T11:58:00.000Z").toISOString(),
          steps: 1,
          success: true,
          summary: "older summary",
          task: "older task",
          type: "run",
          userMessage: "older first message",
        },
      ]);
      await appendSessionEntries("newer-session", [
        {
          assistantMessage: "Newer assistant reply",
          durationMs: 1200,
          endedAt: new Date("2026-03-04T11:01:00.000Z").toISOString(),
          finalState: "waiting_for_user",
          sessionId: "newer-session",
          startedAt: new Date("2026-03-04T11:00:00.000Z").toISOString(),
          steps: 1,
          success: false,
          summary: "newer summary",
          task: "newer task",
          type: "run",
          userMessage: "newer first message",
        },
      ]);
      await appendSessionMetaTitle("older-session", { title: "Older Session Title" });
      await appendSessionMetaTitle("newer-session", { title: "Newer Session Title" });

      const olderPath = getSessionFilePath("older-session");
      const newerPath = getSessionFilePath("newer-session");
      await utimes(olderPath, new Date("2026-03-02T12:00:00.000Z"), new Date("2026-03-02T12:00:00.000Z"));
      await utimes(newerPath, new Date("2026-03-04T11:00:00.000Z"), new Date("2026-03-04T11:00:00.000Z"));

      const catalog = await listSessionCatalog({ now });

      expect(catalog.map((session) => session.sessionId)).toEqual([
        "newer-session",
        "older-session",
      ]);
      expect(catalog[0]?.lastInteractedAgo).toBe("1h ago");
      expect(catalog[1]?.lastInteractedAgo).toBe("2d ago");
      expect(catalog[0]?.title).toBe("Newer Session Title");
      expect(catalog[1]?.title).toBe("Older Session Title");
      expect(catalog[0]?.firstUserMessage).toBeUndefined();
      expect(catalog[1]?.firstUserMessage).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("lists session even when session jsonl contains invalid content", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "zace-session-catalog-invalid-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(baseDir);
      await appendSessionEntries("broken-session", [
        {
          content: "seed content",
          role: "user",
          timestamp: new Date("2026-03-04T12:00:00.000Z").toISOString(),
          type: "message",
        },
      ]);
      await appendFile(getSessionFilePath("broken-session"), "{not-json}\n", "utf8");

      const catalog = await listSessionCatalog({
        now: new Date("2026-03-04T13:00:00.000Z"),
      });

      expect(catalog.some((session) => session.sessionId === "broken-session")).toBeTrue();
    } finally {
      process.chdir(originalCwd);
      await rm(baseDir, { force: true, recursive: true });
    }
  });

  test("relative time formatting clamps future dates", () => {
    const now = new Date("2026-03-04T12:00:00.000Z");
    const value = formatRelativeSessionTime("2026-03-05T12:00:00.000Z", now);
    expect(value).toBe("just now");
  });
});
