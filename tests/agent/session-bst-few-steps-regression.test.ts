import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

describe("session BST few-steps regression", () => {
  test("completes a simple BST write flow in bounded steps", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-bst-few-steps-"));
    const maxSteps = 8;
    const plannerResponses = [
      JSON.stringify({
        action: "continue",
        reasoning: "Write the BST implementation.",
        toolCall: {
          arguments: {
            command: [
              "cat > bst.ts <<'EOF'",
              "export class BstNode {",
              "  left: BstNode | null = null;",
              "  right: BstNode | null = null;",
              "  constructor(public value: number) {}",
              "}",
              "",
              "export class Bst {",
              "  root: BstNode | null = null;",
              "  insert(value: number): void {",
              "    if (!this.root) {",
              "      this.root = new BstNode(value);",
              "      return;",
              "    }",
              "    let current = this.root;",
              "    while (true) {",
              "      if (value < current.value) {",
              "        if (!current.left) {",
              "          current.left = new BstNode(value);",
              "          return;",
              "        }",
              "        current = current.left;",
              "      } else if (!current.right) {",
              "        current.right = new BstNode(value);",
              "        return;",
              "      } else {",
              "        current = current.right;",
              "      }",
              "    }",
              "  }",
              "}",
              "EOF",
              "printf 'ZACE_FILE_CHANGED|bst.ts\\n'",
            ].join("\n"),
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "complete",
        gates: ["printf 'bst validation ok\\n'"],
        reasoning: "BST file was created and validation passed.",
        userMessage: "BST implementation complete.",
      }),
    ];

    const llmClient = {
      chat: async () => ({
        content: plannerResponses.shift() ?? plannerResponses[plannerResponses.length - 1] ?? "{\"action\":\"blocked\",\"reasoning\":\"missing response\"}",
      }),
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const result = await runAgentLoop(
        llmClient,
        createTestConfig(maxSteps),
        "write bst code"
      );

      expect(result.success).toBe(true);
      expect(result.finalState).toBe("completed");
      expect(result.context.currentStep).toBeLessThanOrEqual(4);
    } finally {
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });
});
