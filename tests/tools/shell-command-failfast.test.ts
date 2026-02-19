import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env } from "../../src/config/env";
import { shellTools } from "../../src/tools/shell";

const originalLspEnabled = env.AGENT_LSP_ENABLED;

describe("shell command fail-fast", () => {
  test("fails when an early subcommand fails even if later command would succeed", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-failfast-"));
    env.AGENT_LSP_ENABLED = false;

    try {
      const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
      if (!executeCommandTool) {
        throw new Error("execute_command tool not found");
      }

      const result = await executeCommandTool.execute({
        command: [
          "cat > missing/dir/output.ts <<'EOF'",
          "export const value = 1;",
          "EOF",
          "echo should-not-run",
        ].join("\n"),
        cwd: tempDirectoryPath,
        timeout: 30_000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Command failed with exit code");
      expect(result.output).toMatch(/cannot create|No such file|Directory nonexistent/u);
      expect(result.output).not.toContain("should-not-run");
    } finally {
      env.AGENT_LSP_ENABLED = originalLspEnabled;
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });
});
