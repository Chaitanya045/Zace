import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

describe("brain turn finalization integration", () => {
  test("run loop persists episodic and durable memory at terminal state", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-finalization-"));
    const originalCwd = process.cwd();
    const sessionId = "chat-brain-finalization";

    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
      await writeFile(join(workspaceRoot, "src", "auth.ts"), "before\n", "utf8");
      process.chdir(workspaceRoot);

      const llmClient = {
        chat: async () => ({
          content: JSON.stringify({
            action: "continue",
            planState: {
              currentStepId: "step-1",
              goal: "fix auth bug",
              steps: [
                {
                  id: "step-1",
                  relevantFiles: ["src/auth.ts"],
                  status: "in_progress",
                  title: "Patch auth token validation",
                },
              ],
            },
            reasoning:
              "Architectural decision: standardize auth validation. Repository uses Bun and TypeScript.",
            toolCall: {
              arguments: {
                command: "echo patch",
              },
              name: "bash",
            },
          }),
        }),
        getModelContextWindowTokens: async () => undefined,
      } as unknown as LlmClient;

      const result = await runAgentLoop(llmClient, createTestConfig(), "fix auth bug", {
        executeToolCall: async () => ({
          artifacts: {
            changedFiles: [join(workspaceRoot, "src", "auth.ts")],
          },
          output: "patched auth.ts",
          success: true,
        }),
        sessionId,
      });

      expect(result.finalState).toBe("blocked");

      const sessionLogs = await readdir(join(workspaceRoot, ".zace", "episodic_memory", "session_logs"));
      const episodicLog = await readFile(
        join(workspaceRoot, ".zace", "episodic_memory", "session_logs", sessionLogs[0] ?? ""),
        "utf8"
      );
      const decisions = await readFile(join(workspaceRoot, ".zace", "brain", "decisions.md"), "utf8");
      const knowledge = await readFile(join(workspaceRoot, ".zace", "brain", "knowledge.md"), "utf8");

      expect(sessionLogs.length).toBe(1);
      expect(episodicLog).toContain("Session goal: fix auth bug");
      expect(episodicLog).toContain("src/auth.ts");
      expect(decisions).toContain("Architectural decision: standardize auth validation.");
      expect(knowledge).toContain("Repository uses Bun and TypeScript.");
    } finally {
      process.chdir(originalCwd);
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
