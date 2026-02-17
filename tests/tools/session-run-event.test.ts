import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import {
  appendSessionMessage,
  appendSessionRunEvent,
  getSessionFilePath,
  readSessionEntries,
} from "../../src/tools/session";

function createSessionId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `test-session-run-event-${suffix}`;
}

describe("session run event journaling", () => {
  test("persists run_event entries alongside messages", async () => {
    const sessionId = createSessionId();
    const sessionPath = getSessionFilePath(sessionId);

    try {
      await appendSessionMessage(sessionId, {
        content: "hello",
        role: "user",
      });
      await appendSessionRunEvent(sessionId, {
        event: "plan_started",
        payload: {
          action: "continue",
        },
        phase: "planning",
        runId: "run-1",
        step: 1,
      });

      const entries = await readSessionEntries(sessionId);
      const runEvent = entries.find((entry) => entry.type === "run_event");
      expect(runEvent).toBeDefined();
      expect(runEvent?.type).toBe("run_event");
      if (runEvent?.type === "run_event") {
        expect(runEvent.phase).toBe("planning");
        expect(runEvent.event).toBe("plan_started");
        expect(runEvent.runId).toBe("run-1");
        expect(runEvent.step).toBe(1);
        expect(runEvent.payload).toEqual({
          action: "continue",
        });
      }
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });
});
