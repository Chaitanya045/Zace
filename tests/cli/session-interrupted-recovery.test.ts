import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { loadSessionState } from "../../src/cli/chat-session";
import { appendSessionEntries, readSessionEntries } from "../../src/tools/session";

describe("session interrupted run recovery", () => {
  test("appends synthetic interruption finalization for runs missing final_state_set", async () => {
    const sessionId = "chat-session-interrupted-recovery";
    await mkdir(".zace/sessions", { recursive: true });

    const runId = "run-missing-final";
    await appendSessionEntries(sessionId, [
      {
        event: "run_started",
        payload: { maxSteps: 10 },
        phase: "planning",
        runId,
        step: 0,
        timestamp: new Date("2026-02-18T00:00:00.000Z").toISOString(),
        type: "run_event",
      },
    ]);

    try {
      await loadSessionState(sessionId, 3_600_000, true, true);
      const entries = await readSessionEntries(sessionId);
      const runEvents = entries
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("run_interrupted_recovered");
      expect(runEvents).toContain("final_state_set");
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });
});

