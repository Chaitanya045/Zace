import { describe, expect, test } from "bun:test";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";
import type { ToolExecutionContext, ToolResult } from "../../src/types/tool";

import { runAgentLoop } from "../../src/agent/loop";

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

describe("run loop LLM abort propagation", () => {
  test("passes run abort signal to planner and executor calls", async () => {
    const abortController = new globalThis.AbortController();
    const plannerSignals: Array<globalThis.AbortSignal | undefined> = [];
    const executorSignals: Array<globalThis.AbortSignal | undefined> = [];

    const llmClient = {
      chat: async (
        request: { callKind?: string },
        options?: {
          abortSignal?: globalThis.AbortSignal;
        }
      ) => {
        if (request.callKind === "planner") {
          plannerSignals.push(options?.abortSignal);
          return {
            content: JSON.stringify({
              action: "continue",
              reasoning: "Run command to collect output.",
              toolCall: {
                arguments: {
                  command: "echo hi",
                },
                name: "execute_command",
              },
            }),
          };
        }

        if (request.callKind === "executor") {
          executorSignals.push(options?.abortSignal);
          return {
            content: JSON.stringify({
              analysis: "Looks good.",
              retryDelayMs: 0,
              shouldRetry: false,
            }),
          };
        }

        return {
          content: JSON.stringify({
            action: "ask_user",
            reasoning: "Unexpected call kind.",
            userMessage: "Unexpected call kind.",
          }),
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    const result = await runAgentLoop(llmClient, createTestConfig(), "task", {
      abortSignal: abortController.signal,
      executeToolCall: async (
        toolCall: { arguments: Record<string, unknown>; name: string },
        _context?: ToolExecutionContext
      ): Promise<ToolResult> => {
        expect(["bash", "execute_command"]).toContain(toolCall.name);
        return {
          artifacts: {
            changedFiles: [],
            lifecycleEvent: "none",
            progressSignal: "success_without_changes",
          },
          output: "hi",
          success: true,
        };
      },
    });

    expect(result.finalState).toBe("blocked");
    expect(plannerSignals).toHaveLength(1);
    expect(executorSignals).toHaveLength(1);
    expect(plannerSignals[0]).toBe(abortController.signal);
    expect(executorSignals[0]).toBe(abortController.signal);
  });
});
