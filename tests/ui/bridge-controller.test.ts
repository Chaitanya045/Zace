import { describe, expect, test } from "bun:test";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";
import type { BridgeEvent } from "../../src/ui/bridge/protocol";

import { BridgeController } from "../../src/ui/bridge/controller";

describe("BridgeController command orchestration", () => {
  test("returns shouldExit for exit command", async () => {
    const events: BridgeEvent[] = [];
    const controller = new BridgeController({
      client: {} as LlmClient,
      config: {} as AgentConfig,
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
      config: {} as AgentConfig,
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
      config: {} as AgentConfig,
      emitEvent: () => {
        // no-op
      },
      sessionFilePath: ".zace/sessions/test.jsonl",
      sessionId: "test-session",
    });

    const result = await controller.interrupt();
    expect(result.status).toBe("not_running");
  });
});
