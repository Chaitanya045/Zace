import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import { SessionProcessor } from "../../src/session/processor/session-processor";
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
    stagnationWindow: 3,
    stream: false,
    transientRetryMaxAttempts: 1,
    transientRetryMaxDelayMs: 1000,
    verbose: false,
    writeRegressionErrorSpike: 40,
    ...overrides,
  };
}

describe("session processor terminal records", () => {
  test("persists summary and run entries when interrupted during planner call", async () => {
    const sessionId = "chat-session-processor-interrupted";
    await mkdir(".zace/sessions", { recursive: true });

    const abortController = new globalThis.AbortController();
    const llmClient = {
      chat: async (
        _request: unknown,
        options?: {
          abortSignal?: globalThis.AbortSignal;
        }
      ) =>
        await new Promise<{
          content: string;
        }>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) {
            reject(new Error("Expected abort signal"));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }

          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(signal.reason ?? new Error("aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    const abortTimer = setTimeout(() => {
      abortController.abort(new Error("user_interrupt"));
    }, 15);

    try {
      const turn = await SessionProcessor.runTurn({
        abortSignal: abortController.signal,
        client: llmClient,
        config: createTestConfig(),
        sessionId,
        task: "task",
        userMessage: "hello",
      });

      expect(turn.result.finalState).toBe("interrupted");
      const entries = await readSessionEntries(sessionId);
      const summaries = entries.filter((entry) => entry.type === "summary");
      const runs = entries.filter((entry) => entry.type === "run");
      expect(summaries).toHaveLength(1);
      expect(runs).toHaveLength(1);
      expect(summaries[0]?.type).toBe("summary");
      expect(runs[0]?.type).toBe("run");
      if (summaries[0]?.type === "summary") {
        expect(summaries[0].finalState).toBe("interrupted");
      }
      if (runs[0]?.type === "run") {
        expect(runs[0].finalState).toBe("interrupted");
      }
    } finally {
      clearTimeout(abortTimer);
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });

  test("persists summary and run entries when llm call errors", async () => {
    const sessionId = "chat-session-processor-error";
    await mkdir(".zace/sessions", { recursive: true });

    const llmClient = {
      chat: async () => {
        throw new Error("Simulated LLM timeout");
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const turn = await SessionProcessor.runTurn({
        client: llmClient,
        config: createTestConfig(),
        sessionId,
        task: "task",
        userMessage: "hello",
      });

      expect(turn.result.finalState).toBe("error");
      expect(turn.result.success).toBeFalse();
      const entries = await readSessionEntries(sessionId);
      const summaries = entries.filter((entry) => entry.type === "summary");
      const runs = entries.filter((entry) => entry.type === "run");
      expect(summaries).toHaveLength(1);
      expect(runs).toHaveLength(1);
      if (summaries[0]?.type === "summary") {
        expect(summaries[0].finalState).toBe("error");
      }
      if (runs[0]?.type === "run") {
        expect(runs[0].finalState).toBe("error");
      }
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });
});
