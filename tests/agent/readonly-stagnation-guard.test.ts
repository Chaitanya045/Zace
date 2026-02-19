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
    lspEnabled: false,
    lspMaxDiagnosticsPerFile: 20,
    lspMaxFilesInOutput: 5,
    lspProvisionMaxAttempts: 2,
    lspServerConfigPath: ".zace/runtime/lsp/servers.json",
    lspWaitForDiagnosticsMs: 500,
    maxSteps: 8,
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

describe("read-only stagnation guard", () => {
  test("blocks when repeated read-only inspection happens after a write without validation", async () => {
    const sessionId = "chat-readonly-stagnation-guard";
    await mkdir(".zace/sessions", { recursive: true });

    const injectedToolExecutor = async (
      toolCall: { arguments: Record<string, unknown>; name: string },
      _context?: ToolExecutionContext
    ): Promise<ToolResult> => {
      const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
      if (command.includes("echo hi > src/a.ts")) {
        return {
          artifacts: {
            changedFiles: ["/repo/src/a.ts"],
            lifecycleEvent: "none",
            progressSignal: "files_changed",
          },
          output: "wrote a file",
          success: true,
        };
      }
      if (/\b(?:cat|wc|ls|stat)\b/u.test(command)) {
        return {
          artifacts: {
            changedFiles: [],
            lifecycleEvent: "none",
            progressSignal: "success_without_changes",
          },
          output: `inspected:${command}`,
          success: true,
        };
      }

      return {
        artifacts: {
          changedFiles: [],
          lifecycleEvent: "none",
          progressSignal: "success_without_changes",
        },
        output: "startup ok",
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
              reasoning: "Write something.",
              toolCall: {
                arguments: {
                  command: "echo hi > src/a.ts",
                },
                name: "execute_command",
              },
            }),
          };
        }

        const inspectionCommands = [
          "cat src/a.ts",
          "wc -l src/a.ts",
          "ls -la src",
          "stat src/a.ts",
        ];
        const command = inspectionCommands[(plannerCalls - 2) % inspectionCommands.length] ?? "cat src/a.ts";
        return {
          content: JSON.stringify({
            action: "continue",
            reasoning: "Inspect repeatedly.",
            toolCall: {
              arguments: {
                command,
              },
              name: "execute_command",
            },
          }),
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const result = await runAgentLoop(llmClient, createTestConfig({ readonlyStagnationWindow: 4 }), "task", {
        executeToolCall: injectedToolExecutor,
        sessionId,
      });

      expect(result.finalState).toBe("waiting_for_user");
      const runEvents = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("readonly_stagnation_guard_triggered");
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });
});

