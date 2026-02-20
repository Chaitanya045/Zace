import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { env } from "../../src/config/env";
import { shutdownLsp } from "../../src/lsp";
import { shellTools } from "../../src/tools/shell";

const FAKE_LSP_SERVER_SCRIPT = `
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

function sendMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write("Content-Length: " + String(payload.length) + "\\r\\n\\r\\n");
  process.stdout.write(payload);
}

function publishDiagnostics() {
  for (const fileName of ["sample.ts", "demo.ts", "race.ts"]) {
    sendMessage({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        diagnostics: [
          {
            message: "Fake type error",
            range: {
              end: { character: 10, line: 0 },
              start: { character: 0, line: 0 }
            },
            severity: 1
          }
        ],
        uri: pathToFileURL(resolve(process.cwd(), fileName)).href
      }
    });
  }
}

for (let id = 0; id < 16; id += 1) {
  sendMessage({
    id,
    jsonrpc: "2.0",
    result: { capabilities: { textDocumentSync: 2 } }
  });
}
setTimeout(publishDiagnostics, 10);
setInterval(publishDiagnostics, 150);
`;

const originalLspEnabled = env.AGENT_LSP_ENABLED;
const originalLspServerConfigPath = env.AGENT_LSP_SERVER_CONFIG_PATH;
const originalWaitMs = env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS;
const lspServerExecutable = process.execPath;

let tempDirectoryPath = "";

async function writeLspConfig(tempDirectory: string): Promise<string> {
  const runtimeDirectory = join(tempDirectory, ".zace", "runtime", "lsp");
  await mkdir(runtimeDirectory, { recursive: true });
  const rootMarker = ".lsp-root";
  await writeFile(join(tempDirectory, rootMarker), "lsp root\n", "utf8");

  const serverScriptPath = join(tempDirectory, "fake-lsp-server.js");
  await writeFile(serverScriptPath, FAKE_LSP_SERVER_SCRIPT, "utf8");

  const configPath = join(runtimeDirectory, "servers.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        servers: [
          {
            command: [lspServerExecutable, serverScriptPath],
            extensions: [".ts"],
            id: "fake-lsp",
            rootMarkers: [rootMarker],
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  return configPath;
}

describe("shell execute_command + LSP diagnostics integration", () => {
  beforeEach(async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-lsp-test-"));
    env.AGENT_LSP_ENABLED = true;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = 500;
    env.AGENT_LSP_SERVER_CONFIG_PATH = await writeLspConfig(tempDirectoryPath);
  });

  afterEach(async () => {
    await shutdownLsp();
    env.AGENT_LSP_ENABLED = originalLspEnabled;
    env.AGENT_LSP_SERVER_CONFIG_PATH = originalLspServerConfigPath;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = originalWaitMs;

    if (tempDirectoryPath) {
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });

  test("appends diagnostics for marker-reported changed files", async () => {
    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    expect(executeCommandTool).toBeDefined();

    const result = await executeCommandTool!.execute({
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
    expect(result.output).toContain("[lsp]");
    expect(result.output).toContain("Fake type error");
    expect(result.artifacts?.lspDiagnosticsIncluded).toBe(true);
    expect(result.artifacts?.lspDiagnosticsFiles?.length).toBe(1);
    expect(result.artifacts?.changedFiles).toContain(resolve(tempDirectoryPath, "sample.ts"));
  });

  test("reports no_active_server status when no server config is available", async () => {
    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    expect(executeCommandTool).toBeDefined();

    env.AGENT_LSP_SERVER_CONFIG_PATH = join(tempDirectoryPath, ".zace", "runtime", "lsp", "missing.json");

    const result = await executeCommandTool!.execute({
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
    expect(result.output).toContain("No active LSP server for changed files");
    expect(result.artifacts?.lspStatus).toBe("no_active_server");
  });

  test("reports failed status when servers.json schema is invalid", async () => {
    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    expect(executeCommandTool).toBeDefined();

    const invalidConfigPath = join(tempDirectoryPath, ".zace", "runtime", "lsp", "invalid-servers.json");
    await writeFile(
      invalidConfigPath,
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
    env.AGENT_LSP_SERVER_CONFIG_PATH = invalidConfigPath;

    const result = await executeCommandTool!.execute({
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
    expect(result.output).toContain("status: failed");
    expect(result.artifacts?.lspStatus).toBe("failed");
    expect(result.artifacts?.lspStatusReason).toBeDefined();
  });
});
