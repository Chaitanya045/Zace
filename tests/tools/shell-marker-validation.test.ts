import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { env } from "../../src/config/env";
import { shellTools } from "../../src/tools/shell";

const originalLspEnabled = env.AGENT_LSP_ENABLED;

describe("shell marker validation", () => {
  test("rejects marker paths that do not exist and are absent from git delta", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-marker-validation-"));
    env.AGENT_LSP_ENABLED = false;

    try {
      const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
      if (!executeCommandTool) {
        throw new Error("execute_command tool not found");
      }

      const result = await executeCommandTool.execute({
        command: "printf 'ZACE_FILE_CHANGED|ghost.ts\\n'",
        cwd: tempDirectoryPath,
        timeout: 30_000,
      });

      const ghostPath = resolve(tempDirectoryPath, "ghost.ts");
      expect(result.success).toBe(true);
      expect(result.artifacts?.changedFiles ?? []).not.toContain(ghostPath);
      expect(result.artifacts?.changedFilesSource ?? []).not.toContain("marker");
      expect(result.artifacts?.markerValidationAcceptedCount).toBe(0);
      expect(result.artifacts?.markerValidationRejectedCount).toBe(1);
      expect(result.artifacts?.markerChangedFilesRejected).toEqual([ghostPath]);
    } finally {
      env.AGENT_LSP_ENABLED = originalLspEnabled;
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });
});
