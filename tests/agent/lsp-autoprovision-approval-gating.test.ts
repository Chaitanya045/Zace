import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { createAutoSessionId } from "../../src/cli/chat-session";
import { env } from "../../src/config/env";
import { shutdownLsp } from "../../src/lsp";
import { getSessionFilePath, readSessionEntries } from "../../src/tools/session";

const originalLspEnabled = env.AGENT_LSP_ENABLED;
const originalLspServerConfigPath = env.AGENT_LSP_SERVER_CONFIG_PATH;
const originalLspWaitMs = env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS;

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
    lspEnabled: true,
    lspMaxDiagnosticsPerFile: 20,
    lspMaxFilesInOutput: 5,
    lspProvisionMaxAttempts: 2,
    lspServerConfigPath: ".zace/runtime/lsp/servers.json",
    lspWaitForDiagnosticsMs: 150,
    maxSteps,
    pendingActionMaxAgeMs: 3_600_000,
    plannerParseMaxRepairs: 2,
    plannerParseRetryOnFailure: true,
    readonlyStagnationWindow: 4,
    requireRiskyConfirmation: true,
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

describe("runtime LSP auto-provision approval gating", () => {
  afterEach(async () => {
    await shutdownLsp();
    env.AGENT_LSP_ENABLED = originalLspEnabled;
    env.AGENT_LSP_SERVER_CONFIG_PATH = originalLspServerConfigPath;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = originalLspWaitMs;
  });

  test("requests user approval before running auto-provision command when safety marks it destructive", async () => {
    const tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-lsp-autoprovision-approval-"));
    const sessionId = createAutoSessionId(new Date("2026-02-21T11:00:00.000Z"));
    const sessionPath = getSessionFilePath(sessionId);

    env.AGENT_LSP_ENABLED = true;
    env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS = 100;
    env.AGENT_LSP_SERVER_CONFIG_PATH = join(
      tempDirectoryPath,
      ".zace",
      "runtime",
      "lsp",
      "servers.json"
    );
    await mkdir(join(tempDirectoryPath, ".zace", "runtime", "lsp"), { recursive: true });
    await writeFile(env.AGENT_LSP_SERVER_CONFIG_PATH, JSON.stringify({ servers: [] }, null, 2) + "\n", "utf8");

    const plannerResponses = [
      JSON.stringify({
        action: "continue",
        reasoning: "Create TypeScript file to produce diagnostic candidates.",
        toolCall: {
          arguments: {
            command: [
              "cat > demo.ts <<'EOF'",
              "const answer: number = 42;",
              "EOF",
              "printf 'ZACE_FILE_CHANGED|demo.ts\\n'",
            ].join("\n"),
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
      chat: async (req: { callKind?: string; messages?: Array<{ role: string; content: string }> }) => {
        if (req.callKind === "safety") {
          // Treat the bun -e autoprovision command as destructive to force approval gating.
          return {
            content: JSON.stringify({ isDestructive: true, reason: "test: treat autoprovision as destructive" }),
          };
        }
        return {
          content: plannerResponses.shift() ?? "{\"action\":\"blocked\",\"reasoning\":\"missing response\"}",
        };
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const result = await runAgentLoop(llmClient, createTestConfig(4), "create demo", { sessionId });

      expect(result.finalState).toBe("waiting_for_user");
      expect(result.message).toContain("ZACE_APPROVE_RISKY");

      const entries = await readSessionEntries(sessionId);
      const runEvents = entries
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(runEvents).toContain("approval_requested");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  }, 20_000);
});
