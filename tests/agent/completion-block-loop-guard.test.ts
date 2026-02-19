import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { createAutoSessionId } from "../../src/cli/chat-session";
import { getSessionFilePath, readSessionEntries } from "../../src/tools/session";

function createTestConfig(): AgentConfig {
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
    maxSteps: 6,
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

describe("completion block loop guard", () => {
  test("stops repeated identical completion blocks early and asks user", async () => {
    const sessionId = createAutoSessionId(new Date("2026-02-19T10:30:00.000Z"));
    const sessionPath = getSessionFilePath(sessionId);

    const llmClient = {
      chat: async () => ({
        content: JSON.stringify({
          action: "complete",
          reasoning: "Task is done.",
          userMessage: "Done.",
        }),
      }),
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const result = await runAgentLoop(
        llmClient,
        createTestConfig(),
        "write bst implementation",
        { sessionId }
      );

      expect(result.finalState).toBe("waiting_for_user");
      expect(result.message.toLowerCase()).toContain("repeatedly blocked");
      expect(result.context.currentStep).toBeLessThan(createTestConfig().maxSteps);

      const sessionEntries = await readSessionEntries(sessionId);
      const runEvents = sessionEntries.filter((entry) => entry.type === "run_event");
      expect(
        runEvents.some((entry) => entry.event === "completion_block_loop_guard_triggered")
      ).toBe(true);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });
});
