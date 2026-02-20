import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { createAutoSessionId } from "../../src/cli/chat-session";
import { getSessionFilePath, readSessionEntries } from "../../src/tools/session";

function createTestConfig(maxSteps: number): AgentConfig {
  return {
    approvalMemoryEnabled: false,
    approvalRulesPath: ".zace/runtime/policy/approvals.json",
    commandAllowPatterns: [],
    commandDenyPatterns: [],
    compactionEnabled: true,
    compactionPreserveRecentMessages: 12,
    compactionTriggerRatio: 0.8,
    completionBlockRepeatLimit: 2,
    completionRequireDiscoveredGates: false,
    completionRequireLsp: false,
    completionValidationMode: "llm_only",
    contextWindowTokens: undefined,
    docContextMaxChars: 6000,
    docContextMaxFiles: 3,
    docContextMode: "targeted",
    doomLoopThreshold: 3,
    executorAnalysis: "on_failure",
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
    lspWaitForDiagnosticsMs: 300,
    maxSteps,
    pendingActionMaxAgeMs: 3_600_000,
    plannerParseMaxRepairs: 2,
    plannerParseRetryOnFailure: true,
    readonlyStagnationWindow: 4,
    requireRiskyConfirmation: false,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    runtimeScriptEnforced: false,
    stagnationWindow: 3,
    stream: false,
    transientRetryMaxAttempts: 1,
    transientRetryMaxDelayMs: 1_000,
    verbose: false,
    writeRegressionErrorSpike: 40,
  };
}

describe("session 20260220 repeated inspect regression", () => {
  test("recovers from repeated inspect loop once before hard pre-exec guard", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-repeated-inspect-"));
    const absoluteSrcPath = resolve(tempDirectoryPath, "src");
    const sessionId = createAutoSessionId(new Date("2026-02-20T07:06:45.000Z"));
    const sessionPath = getSessionFilePath(sessionId);
    const plannerResponses = [
      JSON.stringify({
        action: "continue",
        reasoning: "Inspect src directory.",
        toolCall: {
          arguments: {
            command: "ls -la src/",
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "continue",
        reasoning: "Inspect src directory with absolute path.",
        toolCall: {
          arguments: {
            command: `ls -la ${absoluteSrcPath}/`,
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "continue",
        reasoning: "Inspect src directory again.",
        toolCall: {
          arguments: {
            command: "ls -la src/",
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "complete",
        gates: "none",
        reasoning: "Inspection complete.",
        userMessage: "done",
      }),
    ];

    const llmClient = {
      chat: async () => ({
        content: plannerResponses.shift() ?? "{\"action\":\"blocked\",\"reasoning\":\"missing planner response\"}",
      }),
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      await mkdir(absoluteSrcPath, { recursive: true });
      await writeFile(join(absoluteSrcPath, "index.ts"), "export const x = 1;\n", "utf8");

      const result = await runAgentLoop(
        llmClient,
        createTestConfig(6),
        "inspect src and complete",
        { sessionId }
      );

      expect(result.success).toBe(true);
      expect(result.finalState).toBe("completed");
      expect(result.message.toLowerCase()).not.toContain("repeated tool-call loop");

      const runEvents = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("inspection_loop_recovery_triggered");
      expect(runEvents).not.toContain("loop_guard_triggered");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });
});
