import { describe, expect, test } from "bun:test";

import type { LlmRequest } from "../../src/llm/types";
import type { AgentConfig } from "../../src/types/config";

import { LlmClient } from "../../src/llm/client";

function createClient(overrides?: Partial<AgentConfig>): LlmClient {
  return new LlmClient({
    llmApiKey: "test-key",
    llmCompatNormalizeToolRole: true,
    llmModel: "test-model",
    llmProvider: "openrouter",
    stream: false,
    ...overrides,
  } as AgentConfig);
}

function createAbortAwareHangingFetch(signalCollector: AbortSignal[]): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) {
      throw new Error("Missing fetch signal");
    }

    signalCollector.push(signal);

    return await new Promise<Response>((_resolve, reject) => {
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

const BASE_REQUEST: LlmRequest = {
  messages: [
    {
      content: "hello",
      role: "user",
    },
  ],
};

describe("llm client timeout guardrails", () => {
  test("aborts hanging non-stream request when caller signal aborts", async () => {
    const originalFetch = globalThis.fetch;
    const seenSignals: AbortSignal[] = [];
    globalThis.fetch = createAbortAwareHangingFetch(seenSignals);

    try {
      const client = createClient({ llmRequestTimeoutMs: 60_000 });
      const abortController = new AbortController();
      const requestPromise = client.chat(BASE_REQUEST, {
        abortSignal: abortController.signal,
        stream: false,
      });
      abortController.abort(new Error("manual_abort"));

      await expect(requestPromise).rejects.toThrow("Failed to call LLM");
      expect(seenSignals).toHaveLength(1);
      expect(seenSignals[0]?.aborted).toBeTrue();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("times out hanging non-stream request and passes fetch signal", async () => {
    const originalFetch = globalThis.fetch;
    const seenSignals: AbortSignal[] = [];
    globalThis.fetch = createAbortAwareHangingFetch(seenSignals);

    try {
      const client = createClient({ llmRequestTimeoutMs: 20 });
      await expect(client.chat(BASE_REQUEST, { stream: false })).rejects.toThrow("Failed to call LLM");
      expect(seenSignals).toHaveLength(1);
      expect(seenSignals[0]?.aborted).toBeTrue();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("times out hanging stream request before body and passes fetch signal", async () => {
    const originalFetch = globalThis.fetch;
    const seenSignals: AbortSignal[] = [];
    globalThis.fetch = createAbortAwareHangingFetch(seenSignals);

    try {
      const client = createClient({
        llmRequestTimeoutMs: 20,
        llmStreamIdleTimeoutMs: 20,
      });
      await expect(client.chat(BASE_REQUEST, { stream: true })).rejects.toThrow("Failed to call LLM");
      expect(seenSignals).toHaveLength(1);
      expect(seenSignals[0]?.aborted).toBeTrue();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
