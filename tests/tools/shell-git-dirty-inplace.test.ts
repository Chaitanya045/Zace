import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env } from "../../src/config/env";
import { shellTools } from "../../src/tools/shell";

const originalLspEnabled = env.AGENT_LSP_ENABLED;

describe("shell git snapshot delta for already-dirty files", () => {
  afterEach(() => {
    env.AGENT_LSP_ENABLED = originalLspEnabled;
  });

  test("detects in-place edits on files that were already dirty", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-git-dirty-"));
    env.AGENT_LSP_ENABLED = false;

    try {
      const initResult = Bun.spawnSync({
        cmd: ["git", "init", tempDirectoryPath],
        stderr: "pipe",
        stdout: "pipe",
      });
      if (initResult.exitCode !== 0) {
        throw new Error("Failed to initialize git repository for test");
      }

      await writeFile(join(tempDirectoryPath, "target.ts"), "before\n", "utf8");

      const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
      if (!executeCommandTool) {
        throw new Error("execute_command tool not found");
      }

      const inPlaceEditCommand = process.platform === "darwin"
        ? "sed -i '' 's/before/after/' target.ts"
        : process.platform === "win32"
          ? "(Get-Content target.ts) -replace 'before','after' | Set-Content target.ts"
          : "sed -i 's/before/after/' target.ts";

      const result = await executeCommandTool.execute({
        command: inPlaceEditCommand,
        cwd: tempDirectoryPath,
        timeout: 30_000,
      });

      expect(result.success).toBe(true);
      expect(
        result.artifacts?.changedFiles?.some((pathValue) => pathValue.endsWith("/target.ts"))
      ).toBe(true);
      expect(result.artifacts?.changedFilesSource).toContain("git_delta");
      expect(result.artifacts?.progressSignal).toBe("files_changed");
    } finally {
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });
});
