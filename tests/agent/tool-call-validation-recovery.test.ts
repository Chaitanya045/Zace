import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";
import type { ToolResult } from "../../src/types/tool";

import { runAgentLoop } from "../../src/agent/loop";
import { readSessionEntries } from "../../src/tools/session";
import { ValidationError } from "../../src/utils/errors";

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

describe("tool call validation recovery", () => {
  test("continues replanning after validation error instead of terminating", async () => {
    const sessionId = "chat-tool-call-validation-recovery";
    await mkdir(".zace/sessions", { recursive: true });

    let injectedValidationFailure = false;
    const injectedToolExecutor = async (toolCall: {
      arguments: Record<string, unknown>;
      name: string;
    }): Promise<ToolResult> => {
      if (toolCall.name !== "execute_command") {
        return {
          output: "unsupported mocked tool",
          success: false,
        };
      }

      const command =
        typeof toolCall.arguments.command === "string"
          ? toolCall.arguments.command.trim()
          : "";
      if (command === "echo hi" && !injectedValidationFailure) {
        injectedValidationFailure = true;
        throw new ValidationError("Invalid arguments for tool execute_command: command is required");
      }

      return {
        output: "ok",
        success: true,
      };
    };

    let plannerCalls = 0;
    const llmClient = {
      chat: async (request: { callKind?: string }) => {
        if (request.callKind !== "planner") {
          return {
            content: JSON.stringify({
              analysis: "No retry needed",
              retryDelayMs: 0,
              shouldRetry: false,
            }),
          };
        }

        plannerCalls += 1;
        if (plannerCalls === 1) {
          return {
            content: JSON.stringify({
              action: "continue",
              reasoning: "Execute command",
              toolCall: {
                arguments: {
                  command: "echo hi",
                },
                name: "execute_command",
              },
            }),
          };
        }

        return {
          content: JSON.stringify({
            action: "complete",
            gates: "none",
            reasoning: "Task completed",
          }),
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const result = await runAgentLoop(llmClient, createTestConfig(), "say hi", {
        executeToolCall: injectedToolExecutor,
        sessionId,
      });

      expect(result.finalState).toBe("completed");
      expect(result.success).toBe(true);

      const runEvents = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("tool_call_validation_failed");
      expect(result.message.toLowerCase()).not.toContain("validation error");
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  }, 20_000);
});
