import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";

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
    completionValidationMode: "strict",
    contextWindowTokens: undefined,
    docContextMaxChars: 6000,
    docContextMaxFiles: 3,
    docContextMode: "targeted",
    doomLoopThreshold: 3,
    executorAnalysis: "on_failure",
    gateDisallowMasking: true,
    llmApiKey: "test",
    llmModel: "test-model",
    llmProvider: "openrouter",
    lspAutoProvision: true,
    lspBootstrapBlockOnFailed: true,
    lspEnabled: false,
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

describe("completion freshness in strict mode", () => {
  test("blocks COMPLETE with gates:none after writes", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-completion-freshness-"));
    try {
      const responses = [
        JSON.stringify({
          action: "continue",
          reasoning: "Create file.",
          toolCall: {
            arguments: {
              command: [
                "cat > demo.ts <<'EOF'",
                "const value = 1;",
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
          userMessage: "Done",
        }),
      ];

      const llmClient = {
        chat: async () => ({
          content: responses.shift() ?? responses[responses.length - 1] ?? "{\"action\":\"blocked\",\"reasoning\":\"No response\"}",
        }),
        getModelContextWindowTokens: async () => undefined,
      } as unknown as LlmClient;

      const result = await runAgentLoop(llmClient, createTestConfig(), "create file");

      expect(result.finalState).toBe("blocked");
      expect(result.message).toContain("gates: none");
    } finally {
      await rm(tempDirectoryPath, { force: true, recursive: true });
      tempDirectoryPath = "";
    }
  }, 20_000);
});
