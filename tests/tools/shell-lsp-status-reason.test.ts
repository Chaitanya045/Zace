import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env } from "../../src/config/env";
import { shutdownLsp } from "../../src/lsp";
import { shellTools } from "../../src/tools/shell";

const originalLspEnabled = env.AGENT_LSP_ENABLED;
const originalLspServerConfigPath = env.AGENT_LSP_SERVER_CONFIG_PATH;
const originalWaitMs = env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS;

let tempDirectoryPath = "";

describe("shell lsp status reasons", () => {
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

  test("returns failed status reason when servers config schema is invalid", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-lsp-reason-"));
    const configDirectory = join(tempDirectoryPath, ".zace", "runtime", "lsp");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "servers.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          typescript: {
            command: ["typescript-language-server", "--stdio"],
            filePatterns: ["*.ts"],
            rootIndicators: ["tsconfig.json"],
          },
        },
        null,
        2
      ),
      "utf8"
    );

    env.AGENT_LSP_ENABLED = true;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = 300;
    env.AGENT_LSP_SERVER_CONFIG_PATH = configPath;

    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    if (!executeCommandTool) {
      throw new Error("execute_command tool not found");
    }

    const result = await executeCommandTool.execute({
      command: [
        "cat > sample.ts <<'EOF'",
        "const broken: string = 1;",
        "EOF",
        "printf 'ZACE_FILE_CHANGED|sample.ts\\n'",
      ].join("\n"),
      cwd: tempDirectoryPath,
      timeout: 30_000,
    });

    expect(result.success).toBe(true);
    expect(result.artifacts?.lspStatus).toBe("failed");
    expect(result.artifacts?.lspStatusReason).toBeDefined();
    expect(result.artifacts?.lspConfigPath).toBe(configPath);
    expect(result.output).toContain("status: failed");
  });

  test("returns no_applicable_files for extension mismatch", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-lsp-reason-"));
    const configDirectory = join(tempDirectoryPath, ".zace", "runtime", "lsp");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "servers.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          servers: [
            {
              command: ["echo", "unused"],
              extensions: [".py"],
              id: "python",
              rootMarkers: [],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    env.AGENT_LSP_ENABLED = true;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = 300;
    env.AGENT_LSP_SERVER_CONFIG_PATH = configPath;

    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    if (!executeCommandTool) {
      throw new Error("execute_command tool not found");
    }

    const result = await executeCommandTool.execute({
      command: [
        "cat > sample.ts <<'EOF'",
        "const value: number = 1;",
        "EOF",
        "printf 'ZACE_FILE_CHANGED|sample.ts\\n'",
      ].join("\n"),
      cwd: tempDirectoryPath,
      timeout: 30_000,
    });

    expect(result.success).toBe(true);
    expect(result.artifacts?.lspStatus).toBe("no_applicable_files");
    expect(result.artifacts?.lspStatusReason).toBe("no_matching_server_for_changed_files");
    expect(result.output).toContain("status: no_applicable_files");
  });
});
