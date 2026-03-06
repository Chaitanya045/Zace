import { describe, expect, test } from "bun:test";
import { access, unlink } from "node:fs/promises";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";
import type { BridgeEvent } from "../../src/ui/bridge/protocol";

import { appendSessionEntries, getSessionFilePath } from "../../src/tools/session";
import { BridgeController } from "../../src/ui/bridge/controller";

function createControllerConfig(): AgentConfig {
  return {
    approvalMemoryEnabled: true,
    interruptedRunRecoveryEnabled: true,
    pendingActionMaxAgeMs: 3_600_000,
  } as AgentConfig;
}

function createRuntimeControllerConfig(overrides?: Partial<AgentConfig>): AgentConfig {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("BridgeController command orchestration", () => {
  test("returns shouldExit for exit command", async () => {
    const events: BridgeEvent[] = [];
    const controller = new BridgeController({
      client: {} as LlmClient,
      config: createControllerConfig(),
      emitEvent: (event) => {
        events.push(event);
      },
      sessionFilePath: ".zace/sessions/test.jsonl",
      sessionId: "test-session",
    });

    const result = await controller.submit({
      command: "exit",
      kind: "command",
    });

    expect(result.shouldExit).toBeTrue();
    expect(events.length).toBe(0);
  });

  test("status command emits a chat message event", async () => {
    const events: BridgeEvent[] = [];
    const controller = new BridgeController({
      client: {} as LlmClient,
      config: createControllerConfig(),
      emitEvent: (event) => {
        events.push(event);
      },
      sessionFilePath: ".zace/sessions/test.jsonl",
      sessionId: "test-session",
    });

    await controller.submit({
      command: "status",
      kind: "command",
    });

    const chatEvent = events.find((event) => event.type === "chat_message");
    expect(chatEvent?.type).toBe("chat_message");
    if (chatEvent?.type === "chat_message") {
      expect(chatEvent.text).toContain("Turns:");
    }
  });

  test("interrupt returns not_running when no turn is active", async () => {
    const controller = new BridgeController({
      client: {} as LlmClient,
      config: createControllerConfig(),
      emitEvent: () => {
        // no-op
      },
      sessionFilePath: ".zace/sessions/test.jsonl",
      sessionId: "test-session",
    });

    const result = await controller.interrupt();
    expect(result.status).toBe("not_running");
  });

  test("listSessions does not call llm title generation", async () => {
    const sessionId = `bridge-list-${Math.random().toString(36).slice(2, 10)}`;
    const sessionPath = getSessionFilePath(sessionId);
    let chatCalls = 0;

    try {
      await appendSessionEntries(sessionId, [
        {
          content: "hello",
          role: "user",
          timestamp: new Date("2026-03-04T09:00:00.000Z").toISOString(),
          type: "message",
        },
      ]);

      const controller = new BridgeController({
        client: {
          chat: async () => {
            chatCalls += 1;
            return {
              content: '{"titles":[]}',
            };
          },
        } as unknown as LlmClient,
        config: createControllerConfig(),
        emitEvent: () => {
          // no-op
        },
        sessionFilePath: sessionPath,
        sessionId,
      });

      const result = await controller.listSessions();
      expect(result.sessions.some((session) => session.sessionId === sessionId)).toBeTrue();
      expect(chatCalls).toBe(0);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });

  test("switch_session blocks while run is active", async () => {
    const controller = new BridgeController({
      client: {} as LlmClient,
      config: createControllerConfig(),
      emitEvent: () => {
        // no-op
      },
      sessionFilePath: ".zace/sessions/test-session.jsonl",
      sessionId: "test-session",
    });

    (controller as unknown as { state: { isBusy: boolean } }).state.isBusy = true;

    await expect(controller.switchSession("other-session")).rejects.toThrow(
      "Cannot switch session while run is active."
    );
  });

  test("switch_session rejects unknown session id", async () => {
    const sessionId = `bridge-switch-base-${Math.random().toString(36).slice(2, 10)}`;
    const sessionPath = getSessionFilePath(sessionId);

    try {
      await appendSessionEntries(sessionId, [
        {
          content: "hello",
          role: "user",
          timestamp: new Date("2026-03-04T09:00:00.000Z").toISOString(),
          type: "message",
        },
      ]);

      const controller = new BridgeController({
        client: {} as LlmClient,
        config: createControllerConfig(),
        emitEvent: () => {
          // no-op
        },
        sessionFilePath: sessionPath,
        sessionId,
      });

      await expect(controller.switchSession("missing-session")).rejects.toThrow(
        "Session not found in current directory."
      );
    } finally {
      await unlink(sessionPath).catch(() => undefined);
    }
  });

  test("switch_session loads target session state and messages", async () => {
    const sourceSessionId = `bridge-switch-source-${Math.random().toString(36).slice(2, 10)}`;
    const targetSessionId = `bridge-switch-target-${Math.random().toString(36).slice(2, 10)}`;
    const sourceSessionPath = getSessionFilePath(sourceSessionId);
    const targetSessionPath = getSessionFilePath(targetSessionId);

    try {
      await appendSessionEntries(sourceSessionId, [
        {
          content: "source hello",
          role: "user",
          timestamp: new Date("2026-03-04T09:10:00.000Z").toISOString(),
          type: "message",
        },
      ]);
      await appendSessionEntries(targetSessionId, [
        {
          assistantMessage: "Target assistant reply",
          durationMs: 1000,
          endedAt: new Date("2026-03-04T09:20:01.000Z").toISOString(),
          finalState: "waiting_for_user",
          sessionId: targetSessionId,
          startedAt: new Date("2026-03-04T09:20:00.000Z").toISOString(),
          steps: 1,
          success: false,
          summary: "Need more details",
          task: "target task",
          type: "run",
          userMessage: "Target first message",
        },
      ]);

      const controller = new BridgeController({
        client: {} as LlmClient,
        config: createControllerConfig(),
        emitEvent: () => {
          // no-op
        },
        sessionFilePath: sourceSessionPath,
        sessionId: sourceSessionId,
      });

      const result = await controller.switchSession(targetSessionId);

      expect(result.state.sessionId).toBe(targetSessionId);
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]?.role).toBe("user");
      expect(result.messages[0]?.text).toBe("Target first message");
      expect(result.messages[1]?.role).toBe("assistant");
      expect(result.messages[1]?.text).toBe("Target assistant reply");
    } finally {
      await unlink(sourceSessionPath).catch(() => undefined);
      await unlink(targetSessionPath).catch(() => undefined);
    }
  });

  test("new_session blocks while run is active", async () => {
    const controller = new BridgeController({
      client: {} as LlmClient,
      config: createControllerConfig(),
      emitEvent: () => {
        // no-op
      },
      sessionFilePath: ".zace/sessions/test-session.jsonl",
      sessionId: "test-session",
    });

    (controller as unknown as { state: { isBusy: boolean } }).state.isBusy = true;

    await expect(controller.newSession()).rejects.toThrow(
      "Cannot switch session while run is active."
    );
  });

  test("new_session creates in-memory session without creating session file", async () => {
    const baseSessionId = `bridge-new-base-${Math.random().toString(36).slice(2, 10)}`;
    const baseSessionPath = getSessionFilePath(baseSessionId);

    let createdSessionPath: string | undefined;
    try {
      await appendSessionEntries(baseSessionId, [
        {
          content: "hello",
          role: "user",
          timestamp: new Date("2026-03-04T11:00:00.000Z").toISOString(),
          type: "message",
        },
      ]);

      const controller = new BridgeController({
        client: {} as LlmClient,
        config: createControllerConfig(),
        emitEvent: () => {
          // no-op
        },
        sessionFilePath: baseSessionPath,
        sessionId: baseSessionId,
      });

      const result = await controller.newSession();
      createdSessionPath = result.state.sessionFilePath;

      expect(result.state.sessionId).toMatch(/^chat-\d{8}-\d{6}-[a-z0-9]{6}$/u);
      expect(result.state.turnCount).toBe(0);
      expect(result.messages.length).toBe(0);
      await expect(access(result.state.sessionFilePath)).rejects.toBeDefined();
    } finally {
      await unlink(baseSessionPath).catch(() => undefined);
      if (createdSessionPath) {
        await unlink(createdSessionPath).catch(() => undefined);
      }
    }
  });

  test("new unsaved session does not appear in listSessions until persisted", async () => {
    const baseSessionId = `bridge-new-list-${Math.random().toString(36).slice(2, 10)}`;
    const baseSessionPath = getSessionFilePath(baseSessionId);

    let newSessionId: string | undefined;
    let newSessionPath: string | undefined;
    try {
      await appendSessionEntries(baseSessionId, [
        {
          content: "hello",
          role: "user",
          timestamp: new Date("2026-03-04T11:10:00.000Z").toISOString(),
          type: "message",
        },
      ]);

      const controller = new BridgeController({
        client: {
          chat: async () => {
            throw new Error("skip title generation");
          },
        } as unknown as LlmClient,
        config: createControllerConfig(),
        emitEvent: () => {
          // no-op
        },
        sessionFilePath: baseSessionPath,
        sessionId: baseSessionId,
      });

      const newSession = await controller.newSession();
      newSessionId = newSession.state.sessionId;
      newSessionPath = newSession.state.sessionFilePath;

      const listed = await controller.listSessions();
      expect(listed.sessions.some((session) => session.sessionId === baseSessionId)).toBeTrue();
      expect(listed.sessions.some((session) => session.sessionId === newSessionId)).toBeFalse();
    } finally {
      await unlink(baseSessionPath).catch(() => undefined);
      if (newSessionPath) {
        await unlink(newSessionPath).catch(() => undefined);
      }
    }
  });

  test("isBusy resets after aborting an in-flight llm request", async () => {
    const sessionId = `bridge-abort-${Math.random().toString(36).slice(2, 10)}`;
    const sessionPath = getSessionFilePath(sessionId);
    const sessionMetaPath = sessionPath.replace(/\.jsonl$/u, ".meta.json");
    const events: BridgeEvent[] = [];
    let callCount = 0;

    const controller = new BridgeController({
      client: {
        chat: async (
          _request: unknown,
          options?: {
            abortSignal?: globalThis.AbortSignal;
          }
        ) => {
          callCount += 1;
          if (callCount === 1) {
            return await new Promise<{ content: string }>((_resolve, reject) => {
              const signal = options?.abortSignal;
              if (!signal) {
                reject(new Error("Missing abort signal"));
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
            });
          }

          return {
            content: `{"titles":[{"sessionId":"${sessionId}","title":"Abort test title"}]}`,
          };
        },
      } as unknown as LlmClient,
      config: createRuntimeControllerConfig(),
      emitEvent: (event) => {
        events.push(event);
      },
      sessionFilePath: sessionPath,
      sessionId,
    });

    try {
      const submitPromise = controller.submit({
        kind: "message",
        text: "hello",
      });
      await delay(20);
      const stateDuringRun = (controller as unknown as { state: { isBusy: boolean } }).state;
      expect(stateDuringRun.isBusy).toBeTrue();

      const interruptResult = await controller.interrupt();
      expect(interruptResult.status).toBe("requested");
      await submitPromise;

      const finalState = (controller as unknown as { state: { isBusy: boolean; runState: string } }).state;
      expect(finalState.isBusy).toBeFalse();
      expect(finalState.runState).toBe("interrupted");

      const stateUpdates = events
        .filter((event): event is Extract<BridgeEvent, { type: "state_update" }> => event.type === "state_update")
        .map((event) => event.state.isBusy);
      expect(stateUpdates).toContain(true);
      expect(stateUpdates[stateUpdates.length - 1]).toBe(false);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
      await unlink(sessionMetaPath).catch(() => undefined);
    }
  });

  test("isBusy resets after llm timeout-like failure", async () => {
    const sessionId = `bridge-timeout-${Math.random().toString(36).slice(2, 10)}`;
    const sessionPath = getSessionFilePath(sessionId);
    const sessionMetaPath = sessionPath.replace(/\.jsonl$/u, ".meta.json");
    const events: BridgeEvent[] = [];
    let callCount = 0;

    const controller = new BridgeController({
      client: {
        chat: async () => {
          callCount += 1;
          if (callCount === 1) {
            await delay(20);
            throw new Error("Failed to call LLM: timeout");
          }

          return {
            content: `{"titles":[{"sessionId":"${sessionId}","title":"Timeout test title"}]}`,
          };
        },
      } as unknown as LlmClient,
      config: createRuntimeControllerConfig(),
      emitEvent: (event) => {
        events.push(event);
      },
      sessionFilePath: sessionPath,
      sessionId,
    });

    try {
      await controller.submit({
        kind: "message",
        text: "hello",
      });

      const finalState = (controller as unknown as { state: { isBusy: boolean; runState: string } }).state;
      expect(finalState.isBusy).toBeFalse();
      expect(finalState.runState).toBe("error");

      const stateUpdates = events
        .filter((event): event is Extract<BridgeEvent, { type: "state_update" }> => event.type === "state_update")
        .map((event) => event.state.isBusy);
      expect(stateUpdates).toContain(true);
      expect(stateUpdates[stateUpdates.length - 1]).toBe(false);
    } finally {
      await unlink(sessionPath).catch(() => undefined);
      await unlink(sessionMetaPath).catch(() => undefined);
    }
  });

  test("background title generation is non-blocking for first-turn submit", async () => {
    const sessionId = `bridge-title-non-blocking-${Math.random().toString(36).slice(2, 10)}`;
    const sessionPath = getSessionFilePath(sessionId);
    const sessionMetaPath = sessionPath.replace(/\.jsonl$/u, ".meta.json");
    let callCount = 0;
    let releaseTitleCall: () => void = () => {
      // no-op default
    };
    const titleCallGate = new Promise<void>((resolve) => {
      releaseTitleCall = resolve;
    });

    const controller = new BridgeController({
      client: {
        chat: async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              content: JSON.stringify({
                action: "ask_user",
                reasoning: "Need clarification.",
                userMessage: "Which file should I edit?",
              }),
            };
          }

          await titleCallGate;
          return {
            content: `{"titles":[{"sessionId":"${sessionId}","title":"Async first turn title"}]}`,
          };
        },
      } as unknown as LlmClient,
      config: createRuntimeControllerConfig(),
      emitEvent: () => {
        // no-op
      },
      sessionFilePath: sessionPath,
      sessionId,
    });

    try {
      const submitPromise = controller.submit({
        kind: "message",
        text: "please help",
      });
      const submitResult = await Promise.race([
        submitPromise.then(() => "resolved" as const),
        delay(200).then(() => "pending" as const),
      ]);

      expect(submitResult).toBe("resolved");
      expect(callCount).toBeGreaterThanOrEqual(2);
      const stateAfterSubmit = (controller as unknown as { state: { isBusy: boolean } }).state;
      expect(stateAfterSubmit.isBusy).toBeFalse();
    } finally {
      releaseTitleCall();
      await delay(10);
      await unlink(sessionPath).catch(() => undefined);
      await unlink(sessionMetaPath).catch(() => undefined);
    }
  });
});
