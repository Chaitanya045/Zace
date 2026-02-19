import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";
import type { ToolExecutionContext, ToolResult } from "../../src/types/tool";

import { runAgentLoop } from "../../src/agent/loop";
import { readSessionEntries } from "../../src/tools/session";

function createTestConfig(overrides?: Partial<AgentConfig>): AgentConfig {
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
    executorAnalysis: "always",
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
    lspWaitForDiagnosticsMs: 500,
    maxSteps: 1,
    pendingActionMaxAgeMs: 3_600_000,
    plannerMaxInvalidArtifactChars: 4000,
    plannerOutputMode: "auto",
    plannerParseMaxRepairs: 1,
    plannerParseRetryOnFailure: true,
    plannerSchemaStrict: true,
    readonlyStagnationWindow: 4,
    requireRiskyConfirmation: false,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    stagnationWindow: 3,
    stream: false,
    transientRetryMaxAttempts: 1,
    transientRetryMaxDelayMs: 1000,
    verbose: false,
    writeRegressionErrorSpike: 40,
    ...overrides,
  };
}

describe("transient-only retry policy", () => {
  test("suppresses retries for deterministic (non-transient) failures even when executor suggests retry", async () => {
    const sessionId = "chat-retry-non-transient-suppressed";
    await mkdir(".zace/sessions", { recursive: true });

    let targetedToolCalls = 0;
    const injectedToolExecutor = async (
      toolCall: { arguments: Record<string, unknown>; name: string },
      _context?: ToolExecutionContext
    ): Promise<ToolResult> => {
      expect(toolCall.name).toBe("execute_command");
      const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
      if (!command.includes("sed -e")) {
        return {
          artifacts: {
            changedFiles: [],
            lifecycleEvent: "none",
            progressSignal: "success_without_changes",
          },
          output: "startup ok",
          success: true,
        };
      }

      targetedToolCalls += 1;
      return {
        artifacts: {
          changedFiles: [],
          exitCode: 1,
          lifecycleEvent: "none",
          progressSignal: "none",
        },
        error: "Command failed with exit code 1",
        output: "sed: bad usage",
        success: false,
      };
    };

    const llmClient = {
      chat: async (request: { callKind?: string }) => {
        if (request.callKind === "planner") {
          return {
            content: JSON.stringify({
              action: "continue",
              reasoning: "Try an edit command.",
              toolCall: {
                arguments: {
                  command: "sed -e 's/a/b/' missing.txt",
                },
                name: "execute_command",
              },
            }),
          };
        }

        return {
          content: JSON.stringify({
            analysis: "Retry the command once.",
            retryDelayMs: 0,
            shouldRetry: true,
          }),
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      await runAgentLoop(llmClient, createTestConfig({ maxSteps: 1, transientRetryMaxAttempts: 5 }), "edit", {
        executeToolCall: injectedToolExecutor,
        sessionId,
      });

      expect(targetedToolCalls).toBe(1);
      const runEvents = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("retry_suppressed_non_transient");
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });

  test("retries once for timeout (transient) failures within cap", async () => {
    const sessionId = "chat-retry-transient-timeout";
    await mkdir(".zace/sessions", { recursive: true });

    let targetedToolCalls = 0;
    const injectedToolExecutor = async (
      toolCall: { arguments: Record<string, unknown>; name: string },
      _context?: ToolExecutionContext
    ): Promise<ToolResult> => {
      const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
      if (!command.includes("sleep 10")) {
        return {
          artifacts: {
            changedFiles: [],
            lifecycleEvent: "none",
            progressSignal: "success_without_changes",
          },
          output: "startup ok",
          success: true,
        };
      }

      targetedToolCalls += 1;
      if (targetedToolCalls === 1) {
        return {
          artifacts: {
            changedFiles: [],
            lifecycleEvent: "timeout",
            progressSignal: "none",
            timedOut: true,
          },
          error: "Command timed out after 1ms",
          output: "timeout",
          success: false,
        };
      }
      return {
        artifacts: {
          changedFiles: [],
          lifecycleEvent: "none",
          progressSignal: "success_without_changes",
        },
        output: "ok",
        success: true,
      };
    };

    const llmClient = {
      chat: async (request: { callKind?: string }) => {
        if (request.callKind === "planner") {
          return {
            content: JSON.stringify({
              action: "continue",
              reasoning: "Run a command.",
              toolCall: {
                arguments: {
                  command: "sleep 10",
                },
                name: "execute_command",
              },
            }),
          };
        }

        return {
          content: JSON.stringify({
            analysis: "Timeout looks transient; retry.",
            retryDelayMs: 0,
            shouldRetry: true,
          }),
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      await runAgentLoop(llmClient, createTestConfig({ transientRetryMaxAttempts: 1 }), "run", {
        executeToolCall: injectedToolExecutor,
        sessionId,
      });
      expect(targetedToolCalls).toBe(2);
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });
});

