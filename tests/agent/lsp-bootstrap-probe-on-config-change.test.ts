import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { env } from "../../src/config/env";
import { shutdownLsp } from "../../src/lsp";
import { getSessionFilePath, readSessionEntries } from "../../src/tools/session";

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
      diagnostics: [],
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
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const contentLengthMatch = headerText.match(/Content-Length:\\s*(\\d+)/iu);
    if (!contentLengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = Number(contentLengthMatch[1]);
    const messageEnd = headerEnd + 4 + contentLength;
    if (buffer.length < messageEnd) return;

    const jsonPayload = buffer.slice(headerEnd + 4, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    try {
      handleMessage(JSON.parse(jsonPayload));
    } catch {
      // ignore malformed payloads in fake server
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
const originalLspWaitMs = env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS;

let sessionPath = "";
let tempDirectoryPath = "";

function createTestConfig(): AgentConfig {
  return {
    approvalMemoryEnabled: false,
    approvalRulesPath: ".zace/runtime/policy/approvals.json",
    commandAllowPatterns: [],
    commandDenyPatterns: [],
    compactionEnabled: true,
    compactionPreserveRecentMessages: 12,
    compactionTriggerRatio: 0.8,
    completionRequireDiscoveredGates: true,
    completionValidationMode: "balanced",
    contextWindowTokens: undefined,
    docContextMaxChars: 6000,
    docContextMaxFiles: 3,
    docContextMode: "targeted",
    doomLoopThreshold: 3,
    executorAnalysis: "on_failure",
    gateDisallowMasking: true,
    llmApiKey: "test",
    llmCompatNormalizeToolRole: true,
    llmModel: "test-model",
    llmProvider: "openrouter",
    lspAutoProvision: true,
    lspBootstrapBlockOnFailed: true,
    lspEnabled: true,
    lspMaxDiagnosticsPerFile: 20,
    lspMaxFilesInOutput: 5,
    lspProvisionMaxAttempts: 2,
    lspServerConfigPath: ".zace/runtime/lsp/servers.json",
    lspWaitForDiagnosticsMs: 500,
    maxSteps: 6,
    pendingActionMaxAgeMs: 3_600_000,
    plannerParseMaxRepairs: 2,
    plannerParseRetryOnFailure: true,
    requireRiskyConfirmation: false,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    stagnationWindow: 3,
    stream: false,
    verbose: false,
  };
}

describe("lsp bootstrap probe on config change", () => {
  afterEach(async () => {
    await shutdownLsp();
    env.AGENT_LSP_ENABLED = originalLspEnabled;
    env.AGENT_LSP_SERVER_CONFIG_PATH = originalLspServerConfigPath;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = originalLspWaitMs;

    if (sessionPath) {
      await unlink(sessionPath).catch(() => undefined);
      sessionPath = "";
    }
    if (tempDirectoryPath) {
      await rm(tempDirectoryPath, { force: true, recursive: true });
      tempDirectoryPath = "";
    }
  });

  test("rewriting servers.json triggers probe and clears bootstrap", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-loop-lsp-probe-"));
    const sessionId = `test-lsp-probe-${Math.random().toString(36).slice(2, 10)}`;
    sessionPath = getSessionFilePath(sessionId);

    const fakeServerPath = join(tempDirectoryPath, "fake-lsp-server.js");
    await writeFile(fakeServerPath, FAKE_LSP_SERVER_SCRIPT, "utf8");

    env.AGENT_LSP_ENABLED = true;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = 500;
    env.AGENT_LSP_SERVER_CONFIG_PATH = join(
      tempDirectoryPath,
      ".zace",
      "runtime",
      "lsp",
      "servers.json"
    );

    const responses = [
      JSON.stringify({
        action: "continue",
        reasoning: "Create source file.",
        toolCall: {
          arguments: {
            command: [
              "cat > demo.ts <<'EOF'",
              "const answer: number = 42;",
              "EOF",
              "printf 'ZACE_FILE_CHANGED|demo.ts\\n'",
            ].join("\n"),
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "continue",
        reasoning: "Write runtime LSP config.",
        toolCall: {
          arguments: {
            command: [
              "mkdir -p .zace/runtime/lsp",
              "cat > .zace/runtime/lsp/servers.json <<'JSON'",
              "{",
              '  "servers": [',
              "    {",
              '      "id": "fake-ts",',
              `      "command": [${JSON.stringify(process.execPath)}, ${JSON.stringify(fakeServerPath)}],`,
              '      "extensions": [".ts"],',
              '      "rootMarkers": []',
              "    }",
              "  ]",
              "}",
              "JSON",
              "printf 'ZACE_FILE_CHANGED|.zace/runtime/lsp/servers.json\\n'",
            ].join("\n"),
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "complete",
        gates: "none",
        reasoning: "Task completed.",
        userMessage: "Done",
      }),
    ];

    const llmClient = {
      chat: async () => ({
        content: responses.shift() ?? responses[responses.length - 1] ?? "{\"action\":\"blocked\",\"reasoning\":\"No response\"}",
      }),
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    const result = await runAgentLoop(llmClient, createTestConfig(), "create a demo file", {
      sessionId,
    });

    expect(result.finalState).toBe("completed");

    const entries = await readSessionEntries(sessionId);
    const runEvents = entries
      .filter((entry) => entry.type === "run_event")
      .map((entry) => entry.event);

    expect(runEvents).toContain("lsp_bootstrap_probe_started");
    expect(runEvents).toContain("lsp_bootstrap_probe_succeeded");
  });
});
