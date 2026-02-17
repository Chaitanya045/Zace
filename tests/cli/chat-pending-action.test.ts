import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import { buildChatTaskWithFollowUp, loadSessionState } from "../../src/cli/chat-session";
import {
  appendSessionEntries,
  appendSessionPendingAction,
  getSessionFilePath,
} from "../../src/tools/session";

function createSessionId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `test-chat-pending-${suffix}`;
}

describe("chat pending-action session behavior", () => {
  test("loadSessionState exposes pending approval and uses its prompt as follow-up", async () => {
    const sessionId = createSessionId();
    const sessionPath = getSessionFilePath(sessionId);

    try {
      await appendSessionEntries(sessionId, [
        {
          assistantMessage: "Need more details.",
          durationMs: 1000,
          endedAt: "2026-02-17T10:00:01.000Z",
          finalState: "waiting_for_user",
          sessionId,
          startedAt: "2026-02-17T10:00:00.000Z",
          steps: 1,
          success: false,
          summary: "Need details",
          task: "task",
          type: "run",
          userMessage: "hello",
        },
      ]);
      await appendSessionPendingAction(sessionId, {
        context: {
          command: "rm -rf ./build",
          commandSignature: "sig:test",
          pendingId: "pending-1",
          reason: "Deletes files",
        },
        kind: "approval",
        prompt: "Approval required for rm -rf ./build",
        runId: "run-1",
        sessionId,
        status: "open",
      });

      const loaded = await loadSessionState(sessionId, 3_600_000);
      expect(loaded.pendingApproval).toBeDefined();
      expect(loaded.pendingFollowUpQuestion).toBe("Approval required for rm -rf ./build");
      expect(loaded.pendingApproval?.context.command).toBe("rm -rf ./build");

      await appendSessionPendingAction(sessionId, {
        context: {
          command: "rm -rf ./build",
          commandSignature: "sig:test",
          pendingId: "pending-1",
          reason: "Deletes files",
          scope: "once",
        },
        kind: "approval",
        prompt: "Approval required for rm -rf ./build",
        runId: "run-1",
        sessionId,
        status: "resolved",
      });

      const loadedAfterResolution = await loadSessionState(sessionId, 3_600_000);
      expect(loadedAfterResolution.pendingApproval).toBeUndefined();
      expect(loadedAfterResolution.pendingFollowUpQuestion).toBe("Need more details.");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });

  test("buildChatTaskWithFollowUp includes approval resolution context block", () => {
    const task = buildChatTaskWithFollowUp(
      [
        {
          assistant: "Needs approval",
          finalState: "waiting_for_user",
          steps: 2,
          user: "run dangerous command",
        },
      ],
      "yes continue once",
      "Please approve command",
      "Approval resolved by user: allow once."
    );

    expect(task).toContain("APPROVAL RESOLUTION CONTEXT");
    expect(task).toContain("allow once");
  });
});
