import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    llmCompatNormalizeToolRole: true,
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

describe("completion auto-gates", () => {
  test("auto-discovers and runs lint/test gates after writes", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-completion-auto-gates-"));
    try {
      await writeFile(
        join(tempDirectoryPath, "package.json"),
        JSON.stringify(
          {
            packageManager: "bun@1.3.0",
            scripts: {
              lint: "sh -c 'echo lint-failed >&2; exit 1'",
              test: "sh -c 'echo tests-ok'",
            },
          },
          null,
          2
        ),
        "utf8"
      );
      await writeFile(join(tempDirectoryPath, "bun.lock"), "", "utf8");

      const responses = [
        JSON.stringify({
          action: "continue",
          reasoning: "Write a file.",
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
          reasoning: "Done.",
          userMessage: "Done.",
        }),
      ];

      const llmClient = {
        chat: async () => ({
          content: responses.shift() ?? "{\"action\":\"blocked\",\"reasoning\":\"No response\"}",
        }),
        getModelContextWindowTokens: async () => undefined,
      } as unknown as LlmClient;

      const result = await runAgentLoop(llmClient, createTestConfig(), "create demo file");

      expect(result.finalState).toBe("blocked");
      expect(result.message).toContain("auto:lint");
      expect(result.message).toContain("failed");
    } finally {
      await rm(tempDirectoryPath, { force: true, recursive: true });
      tempDirectoryPath = "";
    }
  }, 20_000);
});
