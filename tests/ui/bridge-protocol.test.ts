import { describe, expect, test } from "bun:test";

import {
  bridgeClientMessageSchema,
  bridgeEventSchema,
  bridgeResponseSchema,
} from "../../src/ui/bridge/protocol";

describe("ui bridge protocol", () => {
  test("validates submit request payload", () => {
    const parsed = bridgeClientMessageSchema.safeParse({
      id: "1",
      method: "submit",
      params: {
        kind: "message",
        text: "hello",
      },
      type: "request",
    });

    expect(parsed.success).toBeTrue();
  });

  test("rejects invalid approval decision", () => {
    const parsed = bridgeClientMessageSchema.safeParse({
      id: "2",
      method: "approval_reply",
      params: {
        decision: "allow_forever",
      },
      type: "request",
    });

    expect(parsed.success).toBeFalse();
  });

  test("accepts tool status events", () => {
    const parsed = bridgeEventSchema.safeParse({
      attempt: 1,
      status: "started",
      step: 2,
      toolName: "execute_command",
      type: "tool_status",
    });

    expect(parsed.success).toBeTrue();
  });

  test("accepts success and error bridge responses", () => {
    const success = bridgeResponseSchema.safeParse({
      id: "3",
      result: {
        ok: true,
      },
      success: true,
      type: "response",
    });
    const error = bridgeResponseSchema.safeParse({
      error: "boom",
      id: "4",
      success: false,
      type: "response",
    });

    expect(success.success).toBeTrue();
    expect(error.success).toBeTrue();
  });

  test("accepts streaming chat message events", () => {
    const parsed = bridgeEventSchema.safeParse({
      chunk: "delta",
      role: "assistant",
      streamId: "assistant-1",
      text: "hello",
      timestamp: Date.now(),
      type: "chat_message",
    });

    expect(parsed.success).toBeTrue();
  });

  test("accepts list_sessions request", () => {
    const parsed = bridgeClientMessageSchema.safeParse({
      id: "5",
      method: "list_sessions",
      params: {},
      type: "request",
    });

    expect(parsed.success).toBeTrue();
  });

  test("rejects switch_session request without sessionId", () => {
    const parsed = bridgeClientMessageSchema.safeParse({
      id: "6",
      method: "switch_session",
      params: {},
      type: "request",
    });

    expect(parsed.success).toBeFalse();
  });

  test("accepts new_session request", () => {
    const parsed = bridgeClientMessageSchema.safeParse({
      id: "7",
      method: "new_session",
      params: {},
      type: "request",
    });

    expect(parsed.success).toBeTrue();
  });
});
