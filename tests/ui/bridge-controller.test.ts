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
});
