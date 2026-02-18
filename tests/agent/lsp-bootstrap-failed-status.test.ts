import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { env } from "../../src/config/env";
import { shutdownLsp } from "../../src/lsp";

const originalLspEnabled = env.AGENT_LSP_ENABLED;
const originalLspServerConfigPath = env.AGENT_LSP_SERVER_CONFIG_PATH;
const originalLspWaitMs = env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS;

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
    maxSteps: 2,
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

describe("lsp bootstrap failed status handling", () => {
  afterEach(async () => {
    await shutdownLsp();
    env.AGENT_LSP_ENABLED = originalLspEnabled;
    env.AGENT_LSP_SERVER_CONFIG_PATH = originalLspServerConfigPath;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = originalLspWaitMs;

    if (tempDirectoryPath) {
      await rm(tempDirectoryPath, { force: true, recursive: true });
      tempDirectoryPath = "";
    }
  });

  test("blocks completion when LSP status is failed due to invalid config", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-loop-lsp-failed-"));
    const configPath = join(tempDirectoryPath, ".zace", "runtime", "lsp", "servers.json");
    await mkdir(join(tempDirectoryPath, ".zace", "runtime", "lsp"), { recursive: true });
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
        action: "complete",
        gates: "none",
        reasoning: "Done.",
        userMessage: "Completed.",
      }),
    ];

    const llmClient = {
      chat: async () => ({
        content: responses.shift() ?? responses[responses.length - 1] ?? "{\"action\":\"blocked\",\"reasoning\":\"No response\"}",
      }),
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    const result = await runAgentLoop(llmClient, createTestConfig(), "create a demo file");

    expect(result.finalState).toBe("blocked");
    expect(result.message).toContain("LSP bootstrap");
    expect(result.message).toContain("Invalid input");
  });
});
