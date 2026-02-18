import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import {
  buildApprovalCommandSignature,
  createPendingApprovalAction,
  findApprovalRuleDecision,
  findOpenPendingApproval,
  resolveApprovalFromUserReply,
  storeApprovalRule,
} from "../../src/agent/approval";
import { getSessionFilePath, readSessionEntries } from "../../src/tools/session";

function createRulesPath(suffix: string): string {
  return join("/tmp", `zace-approval-rules-${suffix}.json`);
}

function createSessionId(suffix: string): string {
  return `test-approval-flow-${suffix}`;
}

function createTestConfig(rulesPath: string): AgentConfig {
  return {
    approvalMemoryEnabled: true,
    approvalRulesPath: rulesPath,
    commandAllowPatterns: [],
    commandDenyPatterns: [],
    compactionEnabled: true,
    compactionPreserveRecentMessages: 12,
    compactionTriggerRatio: 0.8,
    completionRequireDiscoveredGates: true,
    completionValidationMode: "strict",
    contextWindowTokens: undefined,
    docContextMaxChars: 6000,
    docContextMaxFiles: 3,
    docContextMode: "targeted",
    doomLoopThreshold: 3,
    executorAnalysis: "on_failure",
    gateDisallowMasking: true,
    llmApiKey: "test",
    llmCompatNormalizeToolRole: true,
    llmModel: "test-model",
    llmProvider: "openrouter",
    lspAutoProvision: true,
    lspBootstrapBlockOnFailed: true,
    lspEnabled: false,
    lspMaxDiagnosticsPerFile: 10,
    lspMaxFilesInOutput: 5,
    lspProvisionMaxAttempts: 2,
    lspServerConfigPath: ".zace/runtime/lsp/servers.json",
    lspWaitForDiagnosticsMs: 1000,
    maxSteps: 6,
    pendingActionMaxAgeMs: 3_600_000,
    plannerParseMaxRepairs: 2,
    plannerParseRetryOnFailure: true,
    requireRiskyConfirmation: true,
    riskyConfirmationToken: "ZACE_APPROVE_RISKY",
    stagnationWindow: 3,
    stream: false,
    verbose: false,
  };
}

describe("approval workflow memory", () => {
  test("stores and resolves session-scoped approval rules", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const rulesPath = createRulesPath(suffix);
    const config = createTestConfig(rulesPath);

    try {
      await storeApprovalRule({
        commandSignaturePattern: "sig:test",
        config,
        decision: "allow",
        scope: "session",
        sessionId: "session-a",
      });

      const allowedInSession = await findApprovalRuleDecision({
        commandSignature: "sig:test",
        config,
        sessionId: "session-a",
      });
      const deniedInOtherSession = await findApprovalRuleDecision({
        commandSignature: "sig:test",
        config,
        sessionId: "session-b",
      });

      expect(allowedInSession).toEqual({
        decision: "allow",
        pattern: "sig:test",
        scope: "session",
      });
      expect(deniedInOtherSession).toBeNull();
    } finally {
      await unlink(rulesPath).catch(() => undefined);
    }
  });

  test("resolves pending approval with legacy token as allow-once", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const rulesPath = createRulesPath(suffix);
    const sessionId = createSessionId(suffix);
    const sessionPath = getSessionFilePath(sessionId);
    const config = createTestConfig(rulesPath);
    const command = "rm -rf ./build";
    const commandSignature = buildApprovalCommandSignature(command, process.cwd());

    try {
      await createPendingApprovalAction({
        command,
        commandSignature,
        prompt: "Need confirmation",
        reason: "Deletes build directory",
        runId: "run-1",
        sessionId,
      });

      const pending = await findOpenPendingApproval({
        maxAgeMs: config.pendingActionMaxAgeMs,
        sessionId,
      });
      if (!pending) {
        throw new Error("Expected pending approval action");
      }

      const stubClient = {
        chat: async () => ({
          content: '{"decision":"unclear","reason":"not needed"}',
        }),
      } as unknown as LlmClient;

      const resolution = await resolveApprovalFromUserReply({
        client: stubClient,
        config,
        pendingApproval: pending,
        sessionId,
        userMessage: `Please continue ${config.riskyConfirmationToken}`,
      });

      expect(resolution.status).toBe("resolved");
      if (resolution.status !== "resolved") {
        throw new Error("Expected resolved approval");
      }
      expect(resolution.decision).toBe("allow");
      expect(resolution.scope).toBe("once");
      expect(resolution.commandSignature).toBe(commandSignature);

      const openAfterResolution = await findOpenPendingApproval({
        maxAgeMs: config.pendingActionMaxAgeMs,
        sessionId,
      });
      expect(openAfterResolution).toBeNull();
    } finally {
      await unlink(sessionPath).catch(() => undefined);
      await unlink(rulesPath).catch(() => undefined);
    }
  });

  test("resolves allow-always-session and persists approval rule", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const rulesPath = createRulesPath(suffix);
    const sessionId = createSessionId(suffix);
    const sessionPath = getSessionFilePath(sessionId);
    const config = createTestConfig(rulesPath);
    const command = "rm -rf ./cache";
    const commandSignature = buildApprovalCommandSignature(command, process.cwd());

    try {
      await createPendingApprovalAction({
        command,
        commandSignature,
        prompt: "Need confirmation",
        reason: "Deletes cache directory",
        runId: "run-2",
        sessionId,
      });

      const pending = await findOpenPendingApproval({
        maxAgeMs: config.pendingActionMaxAgeMs,
        sessionId,
      });
      if (!pending) {
        throw new Error("Expected pending approval action");
      }

      const stubClient = {
        chat: async () => ({
          content: '{"decision":"allow_always_session","reason":"user requested always for session"}',
        }),
      } as unknown as LlmClient;

      const resolution = await resolveApprovalFromUserReply({
        client: stubClient,
        config,
        pendingApproval: pending,
        sessionId,
        userMessage: "Always allow this for this session",
      });
      expect(resolution.status).toBe("resolved");
      if (resolution.status !== "resolved") {
        throw new Error("Expected resolved approval");
      }
      expect(resolution.scope).toBe("session");
      expect(resolution.decision).toBe("allow");

      const savedRule = await findApprovalRuleDecision({
        commandSignature,
        config,
        sessionId,
      });
      expect(savedRule).toEqual({
        decision: "allow",
        pattern: commandSignature,
        scope: "session",
      });

      const entries = await readSessionEntries(sessionId);
      const hasApprovalRuleEntry = entries.some((entry) => entry.type === "approval_rule");
      expect(hasApprovalRuleEntry).toBe(true);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
      await unlink(rulesPath).catch(() => undefined);
    }
  });
});
