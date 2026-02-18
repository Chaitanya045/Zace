import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { readSessionEntries } from "../../src/tools/session";
import { LlmError } from "../../src/utils/errors";

function createTestConfig(): AgentConfig {
  return {
    approvalMemoryEnabled: false,
    approvalRulesPath: ".zace/runtime/policy/approvals.json",
    commandAllowPatterns: [],
    commandDenyPatterns: [],
    compactionEnabled: false,
    compactionPreserveRecentMessages: 12,
    compactionTriggerRatio: 0.8,
    completionRequireDiscoveredGates: true,
    completionRequireLsp: false,
    completionValidationMode: "strict",
    contextWindowTokens: undefined,
    docContextMaxChars: 6000,
    docContextMaxFiles: 3,
    docContextMode: "off",
    doomLoopThreshold: 3,
    executorAnalysis: "never",
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
    maxSteps: 4,
    pendingActionMaxAgeMs: 3_600_000,
    plannerMaxInvalidArtifactChars: 4000,
    plannerOutputMode: "auto",
    plannerParseMaxRepairs: 1,
    plannerParseRetryOnFailure: true,
    plannerSchemaStrict: true,
    requireRiskyConfirmation: false,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    stagnationWindow: 3,
    stream: false,
    verbose: false,
  };
}

describe("session 225311 regression", () => {
  test("planner invalid_message_shape no longer crashes loop_error after first tool step", async () => {
    const sessionId = "chat-20260218-225311-regression";
    await mkdir(".zace/sessions", { recursive: true });

    let plannerCallCount = 0;
    const llmClient = {
      chat: async (request: { callKind?: string }) => {
        if (request.callKind !== "planner") {
          return {
            content: JSON.stringify({
              action: "complete",
              gates: "none",
              reasoning: "done",
            }),
          };
        }

        plannerCallCount += 1;
        if (plannerCallCount === 1) {
          return {
            content: JSON.stringify({
              action: "continue",
              reasoning: "Inspect workspace quickly.",
              toolCall: {
                arguments: {
                  command: "ls",
                },
                name: "execute_command",
              },
            }),
          };
        }

        if (plannerCallCount === 2) {
          throw new LlmError("Bad request", undefined, {
            errorClass: "invalid_message_shape",
            providerMessage: "Invalid messages payload after tool response",
            statusCode: 400,
          });
        }

        return {
          content: JSON.stringify({
            action: "complete",
            gates: "none",
            reasoning: "Task complete.",
          }),
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const result = await runAgentLoop(
        llmClient,
        createTestConfig(),
        "List files and then finish.",
        { sessionId }
      );

      expect(result.finalState).toBe("completed");
      expect(result.success).toBe(true);
      const runEvents = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("llm_request_rejected");
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  }, 20_000);
});
