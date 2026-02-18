import { describe, expect, test } from "bun:test";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";

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
    maxSteps: 1,
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

describe("session fallback regression", () => {
  test("does not fall back to generic ask_user after malformed planner output", async () => {
    let chatCalls = 0;
    const llmClient = {
      chat: async () => {
        chatCalls += 1;
        if (chatCalls === 1) {
          return {
            content: "Planning: I'll inspect project files.\n<tool_call>",
          };
        }

        return {
          content: JSON.stringify({
            action: "continue",
            reasoning: "Inspect project root.",
            toolCall: {
              arguments: {
                command: "ls -la",
              },
              name: "execute_command",
            },
          }),
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    const result = await runAgentLoop(
      llmClient,
      createTestConfig(),
      "create a file in this dir and write bst code init"
    );

    expect(chatCalls).toBe(2);
    expect(result.finalState).toBe("blocked");
    expect(result.message).not.toContain("What would you like me to do next?");
    expect(result.context.steps[0]?.toolCall?.name).toBe("execute_command");
  });
});
