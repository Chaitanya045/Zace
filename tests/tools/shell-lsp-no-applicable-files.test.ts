import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env } from "../../src/config/env";
import { shutdownLsp } from "../../src/lsp";
import { shellTools } from "../../src/tools/shell";

const originalLspEnabled = env.AGENT_LSP_ENABLED;
const originalLspServerConfigPath = env.AGENT_LSP_SERVER_CONFIG_PATH;
const originalWaitMs = env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS;

let tempDirectoryPath = "";

describe("shell LSP neutral status for non-applicable files", () => {
  afterEach(async () => {
    await shutdownLsp();
    env.AGENT_LSP_ENABLED = originalLspEnabled;
    env.AGENT_LSP_SERVER_CONFIG_PATH = originalLspServerConfigPath;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = originalWaitMs;

    if (tempDirectoryPath) {
      await rm(tempDirectoryPath, { force: true, recursive: true });
      tempDirectoryPath = "";
    }
  });

  test("returns no_applicable_files for docs-only changes", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-lsp-neutral-"));
    env.AGENT_LSP_ENABLED = true;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = 300;
    env.AGENT_LSP_SERVER_CONFIG_PATH = join(tempDirectoryPath, ".zace", "runtime", "lsp", "servers.json");

    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    if (!executeCommandTool) {
      throw new Error("execute_command tool not found");
    }

    const result = await executeCommandTool.execute({
      command: [
        "cat > README.md <<'EOF'",
        "# test",
        "EOF",
        "printf 'ZACE_FILE_CHANGED|README.md\\n'",
      ].join("\n"),
      cwd: tempDirectoryPath,
      timeout: 30_000,
    });

    expect(result.success).toBe(true);
    expect(result.artifacts?.lspStatus).toBe("no_applicable_files");
    expect(result.artifacts?.lspStatusReason).toBe("no_applicable_changed_files");
    expect(result.output).toContain("status: no_applicable_files");
  });
});
