import type { AgentConfig } from "../types/config";
import type { LlmRequest, LlmResponse } from "./types";

import { LlmError } from "../utils/errors";
import { log } from "../utils/logger";

type ChatOptions = {
  onToken?: (token: string) => void;
  stream?: boolean;
};

export class LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly streamByDefault: boolean;

  constructor(config: AgentConfig) {
    this.apiKey = config.llmApiKey;
    this.model = config.llmModel;
    this.baseUrl = "https://openrouter.ai/api/v1";
    this.streamByDefault = config.stream;
  }

  async chat(request: LlmRequest, options?: ChatOptions): Promise<LlmResponse> {
    log(`Calling LLM with model: ${this.model}`);

    try {
      const shouldStream = options?.stream ?? this.streamByDefault;

      if (shouldStream) {
        return await this.chatStream(request, options?.onToken);
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        body: JSON.stringify({
          messages: request.messages,
          model: this.model,
        }),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/zace-agent",
          "X-Title": "Zace CLI Agent",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LlmError(
          `LLM API request failed: ${response.status} ${response.statusText}. ${errorText}`
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };

      if (data.error) {
        throw new LlmError(`LLM API error: ${data.error.message ?? "Unknown error"}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new LlmError("LLM response missing content");
      }

      return { content };
    } catch (error) {
      if (error instanceof LlmError) {
        throw error;
      }
      throw new LlmError(`Failed to call LLM: ${error instanceof Error ? error.message : "Unknown error"}`, error);
    }
  }

  private async chatStream(request: LlmRequest, onToken?: (token: string) => void): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      body: JSON.stringify({
        messages: request.messages,
        model: this.model,
        stream: true,
      }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/zace-agent",
        "X-Title": "Zace CLI Agent",
      },
      method: "POST",
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LlmError(
        `LLM API request failed: ${response.status} ${response.statusText}. ${errorText}`
      );
    }

    const body = response.body;
    if (!body) {
      throw new LlmError("LLM streaming response missing body");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are newline-delimited. We only care about `data:` lines.
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trimEnd();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();

        if (data === "[DONE]") {
          return { content };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Ignore malformed JSON lines; continue streaming.
          continue;
        }

        const delta =
          (parsed as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta
            ?.content ?? "";
        if (delta) {
          content += delta;
          onToken?.(delta);
        }
      }
    }

    return { content };
  }
}
