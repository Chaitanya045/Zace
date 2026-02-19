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
    executorAnalysis: "never",
    gateDisallowMasking: true,
    interruptedRunRecoveryEnabled: true,
    llmApiKey: "test",
    llmCompatNormalizeToolRole: true,
    llmModel: "test-model",
    llmProvider: "openrouter",
    lspAutoProvision: true,
    lspBootstrapBlockOnFailed: true,
    lspEnabled: true,
    lspMaxDiagnosticsPerFile: 20,
    lspMaxFilesInOutput: 5,
    lspProvisionMaxAttempts: 2,
    lspServerConfigPath: ".zace/runtime/lsp/servers.json",
    lspWaitForDiagnosticsMs: 500,
    maxSteps: 3,
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

describe("post-write regression detection", () => {
  test("emits write_regression_detected when LSP error count spikes after a write", async () => {
    const sessionId = "chat-write-regression-detected";
    await mkdir(".zace/sessions", { recursive: true });

    let targetedWrites = 0;
    const injectedToolExecutor = async (
      toolCall: { arguments: Record<string, unknown>; name: string },
      _context?: ToolExecutionContext
    ): Promise<ToolResult> => {
      const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
      if (!command.includes("echo hi > src/file.ts")) {
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

      targetedWrites += 1;
      if (targetedWrites === 1) {
        return {
          artifacts: {
            changedFiles: ["/repo/src/a.ts"],
            lifecycleEvent: "none",
            lspErrorCount: 1,
            progressSignal: "files_changed",
          },
          output: "write one",
          success: true,
        };
      }
      return {
        artifacts: {
          changedFiles: ["/repo/src/b.ts"],
          lifecycleEvent: "none",
          lspErrorCount: 60,
          progressSignal: "files_changed",
        },
        output: "write two",
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
        if (plannerCalls <= 2) {
          return {
            content: JSON.stringify({
              action: "continue",
              reasoning: "Write again.",
              toolCall: {
                arguments: {
                  command: "echo hi > src/file.ts",
                },
                name: "execute_command",
              },
            }),
          };
        }
        return {
          content: JSON.stringify({
            action: "ask_user",
            reasoning: "done",
            userMessage: "ok?",
          }),
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const result = await runAgentLoop(llmClient, createTestConfig({ writeRegressionErrorSpike: 40 }), "task", {
        executeToolCall: injectedToolExecutor,
        sessionId,
      });

      expect(result.context.steps.some((step) => step.toolResult?.artifacts?.writeRegressionDetected)).toBe(true);
      const runEvents = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("write_regression_detected");
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });
});

