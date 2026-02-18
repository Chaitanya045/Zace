import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { readSessionEntries } from "../../src/tools/session";

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
    plannerMaxInvalidArtifactChars: 4000,
    plannerOutputMode: "prompt_only",
    plannerParseMaxRepairs: 2,
    plannerParseRetryOnFailure: true,
    plannerSchemaStrict: true,
    requireRiskyConfirmation: false,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    stagnationWindow: 3,
    stream: false,
    verbose: false,
  };
}

describe("session 214235 regression", () => {
  test("planner parse exhaustion stores artifact path and emits deterministic run events", async () => {
    const sessionId = "chat-20260218-214235-regression";
    await mkdir(".zace/sessions", { recursive: true });

    try {
      const llmClient = {
        chat: async () => ({
          content: "planner output without any json payload",
        }),
        getModelContextWindowTokens: async () => undefined,
      } as unknown as LlmClient;

      const result = await runAgentLoop(
        llmClient,
        createTestConfig(),
        "create a file in this dir and write bst code init",
        { sessionId }
      );

      expect(result.finalState).toBe("blocked");
      expect(result.message).toContain(".zace/runtime/planner/invalid-");
      const entries = await readSessionEntries(sessionId);
      const runEvents = entries
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("planner_parse_exhausted");
      expect(runEvents).toContain("planner_blocked_parse_exhausted");
      expect(runEvents).toContain("planner_invalid_output_captured");
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  }, 20_000);
});
