import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    runtimeScriptEnforced: true,
    stagnationWindow: 3,
    stream: false,
    transientRetryMaxAttempts: 1,
    transientRetryMaxDelayMs: 1_000,
    verbose: false,
    writeRegressionErrorSpike: 40,
  };
}

describe("runtime script protocol enforcement", () => {
  test("blocks inline mutating command and proceeds after script workflow", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-script-enforcement-"));
    const sessionId = createAutoSessionId(new Date("2026-02-20T09:15:00.000Z"));
    const sessionPath = getSessionFilePath(sessionId);
    const plannerResponses = [
      JSON.stringify({
        action: "continue",
        reasoning: "Write note directly.",
        toolCall: {
          arguments: {
            command: "echo hello > note.txt",
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "continue",
        reasoning: "Author runtime script for note write.",
        toolCall: {
          arguments: {
            command: [
              "mkdir -p .zace/runtime/scripts",
              "cat > .zace/runtime/scripts/write-note.sh <<'EOF'",
              "#!/usr/bin/env bash",
              "set -euo pipefail",
              "# zace-purpose: write note file",
              "echo 'ZACE_SCRIPT_USE|write-note'",
              "echo hello > note.txt",
              "echo 'ZACE_FILE_CHANGED|note.txt'",
              "EOF",
              "chmod +x .zace/runtime/scripts/write-note.sh",
              "echo 'ZACE_SCRIPT_REGISTER|write-note|.zace/runtime/scripts/write-note.sh|write note file'",
            ].join("\n"),
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "continue",
        reasoning: "Run runtime script.",
        toolCall: {
          arguments: {
            command: "bash .zace/runtime/scripts/write-note.sh",
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "complete",
        gates: "none",
        reasoning: "Done",
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
      const result = await runAgentLoop(
        llmClient,
        createTestConfig(8),
        "write note",
        { sessionId }
      );

      expect(result.success).toBe(true);
      expect(result.finalState).toBe("completed");
      expect(result.context.steps[0]?.toolResult?.error).toContain(
        "runtime script protocol"
      );

      const noteContent = await readFile(join(tempDirectoryPath, "note.txt"), "utf8");
      expect(noteContent.trim()).toBe("hello");

      const runEvents = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("script_protocol_blocked");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });

  test("allows inline redirect writes when runtime enforcement disabled", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-script-enforcement-off-"));
    const sessionId = createAutoSessionId(new Date("2026-02-20T10:00:00.000Z"));
    const sessionPath = getSessionFilePath(sessionId);
    const plannerResponses = [
      JSON.stringify({
        action: "continue",
        reasoning: "Write note directly.",
        toolCall: {
          arguments: {
            command: "echo hello > note.txt",
            cwd: tempDirectoryPath,
          },
          name: "execute_command",
        },
      }),
      JSON.stringify({
        action: "complete",
        gates: "none",
        reasoning: "Done",
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
      const result = await runAgentLoop(
        llmClient,
        {
          ...createTestConfig(4),
          runtimeScriptEnforced: false,
        },
        "write note",
        { sessionId }
      );

      expect(result.success).toBe(true);
      expect(result.finalState).toBe("completed");

      const noteContent = await readFile(join(tempDirectoryPath, "note.txt"), "utf8");
      expect(noteContent.trim()).toBe("hello");

      const runEvents = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).not.toContain("script_protocol_blocked");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  });
});
