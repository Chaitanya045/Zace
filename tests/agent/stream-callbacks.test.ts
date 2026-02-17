import { describe, expect, test } from "bun:test";

import type { LlmClient } from "../../src/llm/client";
import type { ToolCall, ToolResult } from "../../src/types/tool";

import { analyzeToolResult } from "../../src/agent/executor";
import { plan } from "../../src/agent/planner";
import { createInitialContext } from "../../src/agent/state";

describe("stream callbacks", () => {
  test("planner invokes stream callbacks in order", async () => {
    const events: string[] = [];
    const client = {
      chat: async (_request: unknown, options?: { onToken?: (token: string) => void }) => {
        options?.onToken?.("hel");
        options?.onToken?.("lo");
        return {
          content: "COMPLETE: done\nGATES: none",
        };
      },
    } as LlmClient;

    const context = createInitialContext("task", 4);
    await plan(
      client,
      context,
      {
        getMessages: () => [],
      },
      {
        onStreamEnd: () => {
          events.push("end");
        },
        onStreamStart: () => {
          events.push("start");
        },
        onStreamToken: (token) => {
          events.push(`token:${token}`);
        },
        stream: true,
      }
    );

    expect(events).toEqual(["start", "token:hel", "token:lo", "end"]);
  });

  test("executor analysis invokes stream callbacks", async () => {
    const events: string[] = [];
    const client = {
      chat: async (_request: unknown, options?: { onToken?: (token: string) => void }) => {
        options?.onToken?.("{");
        options?.onToken?.("}");
        return {
          content: '{"analysis":"ok","shouldRetry":false,"retryDelayMs":0}',
        };
      },
    } as LlmClient;

    const toolCall: ToolCall = {
      arguments: {
        command: "echo hi",
      },
      name: "execute_command",
    };
    const toolResult: ToolResult = {
      output: "hi",
      success: true,
    };

    const result = await analyzeToolResult(client, toolCall, toolResult, {
      onStreamEnd: () => {
        events.push("end");
      },
      onStreamStart: () => {
        events.push("start");
      },
      onStreamToken: (token) => {
        events.push(`token:${token}`);
      },
      stream: true,
    });

    expect(result.analysis).toBe("ok");
    expect(result.shouldRetry).toBe(false);
    expect(events).toEqual(["start", "token:{", "token:}", "end"]);
  });
});
