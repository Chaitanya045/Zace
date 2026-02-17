import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { env } from "../../src/config/env";
import { shutdownLsp } from "../../src/lsp";
import { shellTools } from "../../src/tools/shell";

const FAKE_LSP_SERVER_SCRIPT = `
let buffer = Buffer.alloc(0);

function sendMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write("Content-Length: " + String(payload.length) + "\\r\\n\\r\\n");
  process.stdout.write(payload);
}

function publishDiagnostics(uri) {
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
      uri
    }
  });
}

function handleMessage(message) {
  if (message.method === "initialize") {
    sendMessage({
      id: message.id,
      jsonrpc: "2.0",
      result: { capabilities: { textDocumentSync: 2 } }
    });
    return;
  }

  if (message.method === "initialized") {
    return;
  }

  if (message.method === "textDocument/didOpen") {
    publishDiagnostics(message.params.textDocument.uri);
    return;
  }

  if (message.method === "textDocument/didChange") {
    publishDiagnostics(message.params.textDocument.uri);
    return;
  }

  if (typeof message.id !== "undefined") {
    sendMessage({
      id: message.id,
      jsonrpc: "2.0",
      result: null
    });
  }
}

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      return;
    }

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const contentLengthMatch = headerText.match(/Content-Length:\\s*(\\d+)/iu);
    if (!contentLengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = Number(contentLengthMatch[1]);
    const messageEnd = headerEnd + 4 + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }

    const jsonPayload = buffer.slice(headerEnd + 4, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    try {
      const parsed = JSON.parse(jsonPayload);
      handleMessage(parsed);
    } catch {
      // ignore malformed payloads in the fake server
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});
`;

const originalLspEnabled = env.AGENT_LSP_ENABLED;
const originalLspServerConfigPath = env.AGENT_LSP_SERVER_CONFIG_PATH;
const originalWaitMs = env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS;

let tempDirectoryPath = "";

async function writeLspConfig(tempDirectory: string): Promise<string> {
  const runtimeDirectory = join(tempDirectory, ".zace", "runtime", "lsp");
  await mkdir(runtimeDirectory, { recursive: true });

  const serverScriptPath = join(tempDirectory, "fake-lsp-server.js");
  await writeFile(serverScriptPath, FAKE_LSP_SERVER_SCRIPT, "utf8");

  const configPath = join(runtimeDirectory, "servers.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        servers: [
          {
            command: [process.execPath, serverScriptPath],
            extensions: [".ts"],
            id: "fake-lsp",
            rootMarkers: [],
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
});
