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

describe("brain turn updates integration", () => {
  test("run loop writes working memory, graph, repo map, and importance after a tool step", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-turn-run-"));
    const originalCwd = process.cwd();
    const sessionId = "chat-brain-turn-run";

    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
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
            reasoning: "Fix auth bug by patching token validation.",
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

      const workingMemory = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "working_memory.json"), "utf8")
      ) as {
        goal: null | string;
        relevantFiles: string[];
        sessionId: null | string;
      };
      const repoMap = await readFile(join(workspaceRoot, ".zace", "brain", "repo_map.md"), "utf8");
      const nodes = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "memory_graph", "nodes.json"), "utf8")
      ) as Array<{ filePath?: string; sessionId?: string; type: string }>;
      const fileImportance = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "file_importance.json"), "utf8")
      ) as Record<string, number>;

      expect(workingMemory.goal).toBe("fix auth bug");
      expect(workingMemory.sessionId).toBe(sessionId);
      expect(workingMemory.relevantFiles).toContain("src/auth.ts");
      expect(repoMap).toContain("`src/auth.ts` - TypeScript source file; updated during agent execution.");
      expect(nodes.some((node) => node.type === "file" && node.filePath === "src/auth.ts")).toBeTrue();
      expect(nodes.some((node) => node.type === "session" && node.sessionId === sessionId)).toBeTrue();
      expect(fileImportance["src/auth.ts"]).toBeGreaterThan(0);
    } finally {
      process.chdir(originalCwd);
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
