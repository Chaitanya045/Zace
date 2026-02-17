import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import { createAutoSessionId } from "../../src/cli/chat-session";
import { appendSessionMessage, getSessionFilePath } from "../../src/tools/session";
import { sessionHistoryTools } from "../../src/tools/session-history";

describe("session history search for diagnostics context", () => {
  test("finds persisted LSP diagnostics messages", async () => {
    const sessionId = createAutoSessionId(new Date("2026-02-17T12:34:56.000Z"));
    const sessionPath = getSessionFilePath(sessionId);

    try {
      await appendSessionMessage(sessionId, {
        content: "[lsp]\n<diagnostics file=\"src/main.ts\">\nERROR [1:1] Fake type error\n</diagnostics>",
        role: "tool",
      });

      const searchTool = sessionHistoryTools.find((tool) => tool.name === "search_session_messages");
      expect(searchTool).toBeDefined();

      const result = await searchTool!.execute({
        limit: 10,
        query: "Fake type error",
        sessionId,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Fake type error");
      expect(result.output).toContain("src/main.ts");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });
});
