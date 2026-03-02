import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import type { CompletionPlan } from "../../src/agent/completion";
import type { RunLoopMutableState } from "../../src/agent/core/run-loop/types";
import type { PlanResult } from "../../src/agent/planner/plan";
import type { LlmClient } from "../../src/llm/client";
import type { AgentContext } from "../../src/types/agent";
import type { AgentConfig } from "../../src/types/config";

import { handleExecutionPhase } from "../../src/agent/core/run-loop/execution-phase";
import { createPermissionMemory } from "../../src/permission/memory";
import { getSessionFilePath, readSessionEntries } from "../../src/tools/session";

function createTestConfig(): AgentConfig {
  return {
    approvalMemoryEnabled: true,
    approvalRulesPath: "/tmp/zace-approval-rules-permission-test.json",
    commandAllowPatterns: [],
    commandDenyPatterns: [],
    compactionEnabled: false,
    compactionPreserveRecentMessages: 12,
    compactionTriggerRatio: 0.8,
    completionRequireDiscoveredGates: true,
    completionValidationMode: "strict",
    contextWindowTokens: undefined,
    docContextMaxChars: 6000,
    docContextMaxFiles: 3,
    docContextMode: "targeted",
    doomLoopThreshold: 3,
    executorAnalysis: "never",
    gateDisallowMasking: true,
    interruptedRunRecoveryEnabled: false,
    llmApiKey: "test",
    llmCompatNormalizeToolRole: true,
    llmModel: "test-model",
    llmProvider: "openrouter",
    lspAutoProvision: false,
    lspBootstrapBlockOnFailed: false,
    lspEnabled: false,
    lspMaxDiagnosticsPerFile: 10,
    lspMaxFilesInOutput: 5,
    lspProvisionMaxAttempts: 1,
    lspServerConfigPath: ".zace/runtime/lsp/servers.json",
    lspWaitForDiagnosticsMs: 1000,
    maxSteps: 3,
    pendingActionMaxAgeMs: 3_600_000,
    plannerParseMaxRepairs: 1,
    plannerParseRetryOnFailure: false,
    readonlyStagnationWindow: 2,
    requireRiskyConfirmation: false,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    stagnationWindow: 3,
    stream: false,
    transientRetryMaxAttempts: 0,
    transientRetryMaxDelayMs: 0,
    verbose: false,
    writeRegressionErrorSpike: 40,
  };
}

function makeBaseInput(sessionId: string) {
  const config = createTestConfig();

  type FinalizeResult = {
    context: unknown;
    finalState: string;
    message: string;
    success: boolean;
  };

  const planResult: PlanResult = {
    action: "continue",
    parseAttempts: 1,
    parseMode: "schema_transport",
    rawInvalidCount: 0,
    reasoning: "do a thing",
    toolCall: {
      arguments: {
        content: "hello",
        role: "user",
      },
      name: "write_session_message",
    },
    transportStructured: true,
    usage: undefined,
    userMessage: undefined,
  };

  const completionPlan = { gates: [], source: "none" } satisfies CompletionPlan;

  const context: AgentContext = {
    currentStep: 0,
    fileSummaries: new Map(),
    maxSteps: 10,
    scriptCatalog: new Map(),
    steps: [],
    task: "x",
  };

  const state: RunLoopMutableState = {
    completionBlockedReason: null,
    completionBlockedReasonRepeatCount: 0,
    completionPlan,
    consecutiveNoToolContinues: 0,
    context,
    inspectionLoopRecoverySignatures: new Set<string>(),
    lastCompletionGateFailure: null,
    lastExecutionWorkingDirectory: process.cwd(),
    lastSuccessfulValidationStep: undefined,
    lastToolLoopSignature: "",
    lastToolLoopSignatureCount: 0,
    lastWriteLspErrorCount: undefined,
    lastWriteStep: undefined,
    lastWriteWorkingDirectory: undefined,
    lspBootstrap: {
      attemptedCommands: [],
      lastFailureReason: null,
      pendingChangedFiles: new Set<string>(),
      provisionAttempts: 0,
      state: "idle",
    },
    toolCallSignatureHistory: [],
  };

  return {
    abortSignal: undefined,
    client: {} as unknown as LlmClient,
    config,
    finalizeInterrupted: async () => {
      throw new Error("finalizeInterrupted should not be called");
    },
    finalizeResult: async (result: FinalizeResult) => result,
    lspServerConfigAbsolutePath: "/tmp/servers.json",
    memory: {
      addMessage: () => {},
    },
    observer: undefined,
    permissionMemory: createPermissionMemory([]),
    planResult,
    resolveCommandApproval: async () =>
      Promise.resolve({
        requiredApproval: false,
        scope: "once" as const,
        status: "allow" as const,
      }),
    runId: "run-1",
    runToolCall: async () => ({ output: "ok", success: true }),
    sessionId,
    state,
    stepNumber: 1,
    toolExecutionContext: undefined,
  };
}

describe("tool permission gating", () => {
  test("blocks non-execute_command tool call when permission not yet granted", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const sessionId = `test-permission-flow-${suffix}`;
    const sessionPath = getSessionFilePath(sessionId);

    try {
      const input = makeBaseInput(sessionId);
      const outcome = await handleExecutionPhase(input);

      expect(outcome.kind).toBe("finalized");
      if (outcome.kind !== "finalized") {
        throw new Error("Expected finalized outcome");
      }
      expect(outcome.result.finalState).toBe("waiting_for_user");
      expect(typeof outcome.result.message).toBe("string");
      expect(outcome.result.message).toContain("Permission required");
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });

  test("allows non-execute_command tool call after once approval and consumes it", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const sessionId = `test-permission-flow-${suffix}`;
    const sessionPath = getSessionFilePath(sessionId);

    try {
      const input = makeBaseInput(sessionId);
      input.permissionMemory.allowOnce("write_session_message", "write_session_message");

      let toolCalls = 0;
      input.runToolCall = async () => {
        toolCalls += 1;
        return { output: "ok", success: true };
      };

      const firstOutcome = await handleExecutionPhase(input);
      expect(firstOutcome.kind).toBe("continue_loop");
      expect(toolCalls).toBe(1);

      const secondOutcome = await handleExecutionPhase({
        ...input,
        stepNumber: 2,
      });
      expect(secondOutcome.kind).toBe("finalized");
      if (secondOutcome.kind !== "finalized") {
        throw new Error("Expected finalized outcome");
      }
      expect(secondOutcome.result.finalState).toBe("waiting_for_user");
      expect(secondOutcome.result.message).toContain("Permission required");
      expect(toolCalls).toBe(1);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });

  test("does not require PermissionNext for execute_command tool calls", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const sessionId = `test-permission-flow-${suffix}`;
    const sessionPath = getSessionFilePath(sessionId);

    try {
      const input = makeBaseInput(sessionId);
      input.planResult = {
        ...input.planResult,
        toolCall: {
          arguments: {
            command: "echo hi",
            cwd: process.cwd(),
          },
          name: "execute_command",
        },
      };

      let toolCalls = 0;
      input.runToolCall = async () => {
        toolCalls += 1;
        return { output: "[stdout]\nhi\n\n[stderr]\n(empty)", success: true };
      };

      const outcome = await handleExecutionPhase(input);
      expect(outcome.kind).toBe("continue_loop");
      expect(toolCalls).toBe(1);

      const entries = await readSessionEntries(sessionId);
      const hasPermissionPendingAction = entries.some((entry) =>
        entry.type === "pending_action" && entry.kind === "permission"
      );
      expect(hasPermissionPendingAction).toBe(false);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });
});
