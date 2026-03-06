import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { LlmClient } from "../../src/llm/client";

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
    llmRequestTimeoutMs: 45_000,
    llmStreamIdleTimeoutMs: 20_000,
    lspAutoProvision: true,
    lspBootstrapBlockOnFailed: true,
    lspEnabled: false,
    lspMaxDiagnosticsPerFile: 20,
    lspMaxFilesInOutput: 5,
    lspProvisionMaxAttempts: 2,
    lspServerConfigPath: ".zace/runtime/lsp/servers.json",
    lspWaitForDiagnosticsMs: 500,
    maxSteps: 2,
    pendingActionMaxAgeMs: 3_600_000,
    plannerMaxInvalidArtifactChars: 4000,
    plannerOutputMode: "auto",
    plannerParseMaxRepairs: 1,
    plannerParseRetryOnFailure: true,
    plannerSchemaStrict: true,
    readonlyStagnationWindow: 4,
    requireRiskyConfirmation: false,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    runtimeScriptEnforced: false,
    stagnationWindow: 3,
    stream: false,
    transientRetryMaxAttempts: 1,
    transientRetryMaxDelayMs: 1000,
    verbose: false,
    writeRegressionErrorSpike: 40,
    ...overrides,
  };
}

describe("planner memory persistence", () => {
  test("run loop persists planState from planner responses", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-plan-memory-run-"));
    const originalCwd = process.cwd();

    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
      process.chdir(workspaceRoot);

      const llmClient = {
        chat: async () => ({
          content: JSON.stringify({
            action: "ask_user",
            planState: {
              currentStepId: "step-1",
              goal: "implement auth flow",
              steps: [
                {
                  id: "step-1",
                  relevantFiles: ["src/auth.ts"],
                  status: "in_progress",
                  title: "Inspect auth flow",
                },
                {
                  id: "step-2",
                  relevantFiles: ["src/auth.ts", "tests/auth.test.ts"],
                  status: "pending",
                  title: "Patch auth validation and add tests",
                },
              ],
            },
            reasoning: "Need the target file before editing.",
            userMessage: "Which auth file should I modify?",
          }),
        }),
        getModelContextWindowTokens: async () => undefined,
      } as unknown as LlmClient;

      const result = await runAgentLoop(llmClient, createTestConfig(), "implement auth flow", {
        executeToolCall: async () => ({
          output: "",
          success: true,
        }),
      });

      expect(result.finalState).toBe("waiting_for_user");

      const currentPlan = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "planner", "current_plan.json"), "utf8")
      ) as {
        currentStepId: null | string;
        goal: null | string;
        steps: Array<{ id: string }>;
      };
      const completedTasks = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "planner", "completed_tasks.json"), "utf8")
      ) as unknown[];

      expect(currentPlan.goal).toBe("implement auth flow");
      expect(currentPlan.currentStepId).toBe("step-1");
      expect(currentPlan.steps.map((step) => step.id)).toEqual(["step-1", "step-2"]);
      expect(completedTasks).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
