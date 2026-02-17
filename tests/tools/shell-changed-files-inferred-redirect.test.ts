import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { env } from "../../src/config/env";
import { shellTools } from "../../src/tools/shell";

const originalLspEnabled = env.AGENT_LSP_ENABLED;

describe("shell inferred redirect changed files", () => {
  test("tracks redirected write targets without explicit markers", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-redirect-"));
    env.AGENT_LSP_ENABLED = false;

    try {
      const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
      if (!executeCommandTool) {
        throw new Error("execute_command tool not found");
      }

      const result = await executeCommandTool.execute({
        command: [
          "cat > redirected.txt <<'EOF'",
          "hello",
          "EOF",
        ].join("\n"),
        cwd: tempDirectoryPath,
        timeout: 30_000,
      });

      const expectedFilePath = resolve(tempDirectoryPath, "redirected.txt");
      expect(result.success).toBe(true);
      expect(result.artifacts?.changedFiles).toContain(expectedFilePath);
      expect(result.artifacts?.changedFilesSource).toContain("inferred_redirect");
      expect(result.artifacts?.progressSignal).toBe("files_changed");
    } finally {
      env.AGENT_LSP_ENABLED = originalLspEnabled;
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });
});
