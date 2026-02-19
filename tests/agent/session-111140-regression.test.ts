import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";

function createTestConfig(maxSteps: number): AgentConfig {
  return {
    approvalMemoryEnabled: false,
    approvalRulesPath: ".zace/runtime/policy/approvals.json",
    commandAllowPatterns: [],
    commandDenyPatterns: [],
    compactionEnabled: true,
    compactionPreserveRecentMessages: 12,
    compactionTriggerRatio: 0.8,
    completionBlockRepeatLimit: 2,
    completionRequireDiscoveredGates: true,
    completionRequireLsp: false,
    completionValidationMode: "strict",
    contextWindowTokens: undefined,
    docContextMaxChars: 6000,
    docContextMaxFiles: 3,
    docContextMode: "targeted",
    doomLoopThreshold: 3,
    executorAnalysis: "on_failure",
    gateDisallowMasking: true,
    interruptedRunRecoveryEnabled: true,
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
    lspWaitForDiagnosticsMs: 300,
    maxSteps,
    pendingActionMaxAgeMs: 3_600_000,
    plannerParseMaxRepairs: 2,
    plannerParseRetryOnFailure: true,
    readonlyStagnationWindow: 4,
    requireRiskyConfirmation: false,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    stagnationWindow: 3,
    stream: false,
    transientRetryMaxAttempts: 1,
    transientRetryMaxDelayMs: 1_000,
    verbose: false,
    writeRegressionErrorSpike: 40,
  };
}

describe("session 111140 regression", () => {
  test("enforces discovered gates when planner declares gates:none after writes", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-session-111140-"));
    const maxSteps = 6;
    const plannerResponses = [
      JSON.stringify({
        action: "continue",
        reasoning: "Create fibonacci file.",
        toolCall: {
          arguments: {
            command: [
              "cat > fibonacci.ts <<'EOF'",
              "export function fibonacci(n: number): number {",
              "  if (n <= 1) return n;",
              "  return fibonacci(n - 1) + fibonacci(n - 2);",
              "}",
              "EOF",
              "printf 'ZACE_FILE_CHANGED|fibonacci.ts\\n'",
            ].join("\n"),
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "complete",
        gates: "none",
        reasoning: "Fibonacci file is ready.",
        userMessage: "Fibonacci implementation complete.",
      }),
    ];

    const llmClient = {
      chat: async () => ({
        content: plannerResponses.shift() ?? plannerResponses[plannerResponses.length - 1] ?? "{\"action\":\"blocked\",\"reasoning\":\"missing response\"}",
      }),
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      await writeFile(
        join(tempDirectoryPath, "package.json"),
        JSON.stringify(
          {
            packageManager: "bun@1.3.0",
            scripts: {
              lint: "printf 'lint ok\\n'",
              test: "printf 'test ok\\n'",
            },
          },
          null,
          2
        ),
        "utf8"
      );
      await writeFile(join(tempDirectoryPath, "bun.lock"), "", "utf8");

      const result = await runAgentLoop(
        llmClient,
        createTestConfig(maxSteps),
        "write fibonacci in new file"
      );

      expect(result.success).toBe(true);
      expect(result.finalState).toBe("completed");
      expect(result.context.currentStep).toBeLessThanOrEqual(3);
      expect(result.message).toContain("complete");
    } finally {
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });
});
