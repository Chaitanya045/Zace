import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import { findOpenPendingPermission, resolvePendingPermissionFromUserMessage } from "../../src/permission/resolve";
import { appendSessionPendingAction, getSessionFilePath } from "../../src/tools/session";

function createSessionId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `test-permission-${suffix}`;
}

describe("permission pending-action flow", () => {
  test("findOpenPendingPermission loads latest open permission", async () => {
    const sessionId = createSessionId();
    const sessionPath = getSessionFilePath(sessionId);

    try {
      await appendSessionPendingAction(sessionId, {
        context: {
          always: ["*"],
          metadata: { why: "test" },
          patterns: ["foo"],
          permission: "bash",
          requestId: "req-1",
        },
        kind: "permission",
        prompt: "Permission required: bash",
        runId: "run-1",
        sessionId,
        status: "open",
      });

      const pending = await findOpenPendingPermission({ maxAgeMs: 3_600_000, sessionId });
      expect(pending).not.toBeNull();
      expect(pending?.context.permission).toBe("bash");
      expect(pending?.entry.prompt).toContain("Permission required");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });

  test("resolvePendingPermissionFromUserMessage resolves once", async () => {
    const sessionId = createSessionId();
    const sessionPath = getSessionFilePath(sessionId);

    try {
      await appendSessionPendingAction(sessionId, {
        context: {
          always: ["*"],
          metadata: {},
          patterns: ["*"],
          permission: "bash",
          requestId: "req-1",
        },
        kind: "permission",
        prompt: "Permission required: bash",
        runId: "run-1",
        sessionId,
        status: "open",
      });

      const pending = await findOpenPendingPermission({ maxAgeMs: 3_600_000, sessionId });
      expect(pending).not.toBeNull();
      if (!pending) {
        throw new Error("Expected pending permission");
      }

      const resolution = await resolvePendingPermissionFromUserMessage({
        pending,
        sessionId,
        userInput: "once",
      });
      expect(resolution.status).toBe("resolved");
      if (resolution.status !== "resolved") {
        throw new Error("Expected resolved");
      }
      expect(resolution.reply).toBe("once");

      const after = await findOpenPendingPermission({ maxAgeMs: 3_600_000, sessionId });
      expect(after).toBeNull();
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });
});
