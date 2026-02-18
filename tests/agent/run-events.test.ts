import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { createAutoSessionId } from "../../src/cli/chat-session";
import { getSessionFilePath, readSessionEntries } from "../../src/tools/session";

function createTestConfig(): AgentConfig {
  return {
    approvalMemoryEnabled: true,
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
    lspWaitForDiagnosticsMs: 3000,
    maxSteps: 2,
    pendingActionMaxAgeMs: 3_600_000,
    plannerParseMaxRepairs: 2,
    plannerParseRetryOnFailure: true,
    requireRiskyConfirmation: true,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    stagnationWindow: 3,
    stream: false,
    verbose: false,
  };
}

describe("run events", () => {
  test("run_event entries are persisted in ordered sequence", async () => {
    const sessionId = createAutoSessionId(new Date("2026-02-17T18:00:00.000Z"));
    const sessionPath = getSessionFilePath(sessionId);
    const config = createTestConfig();

    const llmClient = {
      chat: async () => ({
        content: JSON.stringify({
          action: "ask_user",
          reasoning: "Need concrete task details.",
          userMessage: "What file should I modify?",
        }),
      }),
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      await runAgentLoop(llmClient, config, "hello", {
        sessionId,
      });

      const entries = await readSessionEntries(sessionId);
      const runEvents = entries.filter((entry) => entry.type === "run_event");
      const sequence = runEvents.map((event) => event.event);

      expect(sequence).toContain("run_started");
      expect(sequence).toContain("plan_started");
      expect(sequence).toContain("plan_parsed");
      expect(sequence).toContain("final_state_set");
      expect(
        sequence.includes("docs_context_loaded") || sequence.includes("docs_context_skipped")
      ).toBe(true);
      const runStartedIndex = sequence.indexOf("run_started");
      const planStartedIndex = sequence.indexOf("plan_started");
      const planParsedIndex = sequence.indexOf("plan_parsed");
      const finalStateIndex = sequence.indexOf("final_state_set");
      expect(runStartedIndex).toBeLessThan(planStartedIndex);
      expect(planStartedIndex).toBeLessThan(planParsedIndex);
      expect(planParsedIndex).toBeLessThan(finalStateIndex);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });
});
