import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AgentConfig } from "../../src/types/config";

import { runAgentLoop } from "../../src/agent/loop";
import { LlmClient } from "../../src/llm/client";
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

function createAbortAwareHangingFetch(
  signalCollector: globalThis.AbortSignal[]
): typeof fetch {
  return (async (...args: Parameters<typeof fetch>): Promise<globalThis.Response> => {
    const init = args[1];
    const signal = init?.signal;
    if (!(signal instanceof globalThis.AbortSignal)) {
      throw new Error("Missing fetch signal");
    }

    signalCollector.push(signal);

    return await new Promise<globalThis.Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }

      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
}

describe("interrupted run finalization", () => {
  test("aborted run finalizes as interrupted and records terminal events", async () => {
    const sessionId = "chat-interrupted-run-finalization";
    await mkdir(".zace/sessions", { recursive: true });

    const abortController = new globalThis.AbortController();
    abortController.abort();

    const llmClient = {
      chat: async () => {
        throw new Error("LLM should not be called for pre-startup interruption");
      },
      getModelContextWindowTokens: async () => undefined,
    } as unknown as LlmClient;

    try {
      const result = await runAgentLoop(llmClient, createTestConfig(), "task", {
        abortSignal: abortController.signal,
        sessionId,
      });

      expect(result.finalState).toBe("interrupted");
      const events = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(events).toContain("run_started");
      expect(events).toContain("run_interrupted");
      expect(events).toContain("final_state_set");
    } finally {
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });

  test("abort during planner LLM call finalizes as interrupted", async () => {
    const sessionId = "chat-interrupted-during-planner-call";
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
      const result = await runAgentLoop(llmClient, createTestConfig(), "task", {
        abortSignal: abortController.signal,
        sessionId,
      });

      expect(result.finalState).toBe("interrupted");
      expect(result.message).toContain("Run interrupted");
      const events = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(events).toContain("run_started");
      expect(events).toContain("run_interrupted");
      expect(events).toContain("final_state_set");
    } finally {
      clearTimeout(abortTimer);
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });

  test("hanging llm request times out and finalizes with terminal error state", async () => {
    const sessionId = "chat-timeout-terminal-state";
    await mkdir(".zace/sessions", { recursive: true });

    const originalFetch = globalThis.fetch;
    const seenSignals: globalThis.AbortSignal[] = [];
    globalThis.fetch = createAbortAwareHangingFetch(seenSignals);

    try {
      const config = createTestConfig({
        llmRequestTimeoutMs: 20,
        llmStreamIdleTimeoutMs: 20,
      });
      const llmClient = new LlmClient(config);
      const result = await runAgentLoop(llmClient, config, "task", {
        sessionId,
      });

      expect(result.finalState).toBe("error");
      expect(result.success).toBeFalse();
      expect(result.message).toContain("Failed to call LLM");
      expect(seenSignals.length).toBeGreaterThan(0);
      const events = (await readSessionEntries(sessionId))
        .filter((entry) => entry.type === "run_event")
        .map((entry) => entry.event);
      expect(events).toContain("run_started");
      expect(events).toContain("final_state_set");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(join(".zace/sessions", `${sessionId}.jsonl`), { force: true });
    }
  });
});
