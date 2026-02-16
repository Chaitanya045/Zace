import type { AgentConfig } from "../types/config";
import type { LlmRequest, LlmResponse, LlmUsage } from "./types";

import { LlmError } from "../utils/errors";
import { log } from "../utils/logger";

type ChatOptions = {
  onToken?: (token: string) => void;
  stream?: boolean;
};

type OpenRouterModel = {
  context_length?: number;
  id?: string;
};

type OpenRouterUsage = {
  completion_tokens?: number;
  prompt_tokens?: number;
  total_tokens?: number;
};

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const parsed = Math.trunc(value);
  if (parsed < 0) {
    return undefined;
  }

  return parsed;
}

function parseUsage(rawUsage: unknown): LlmUsage | undefined {
  if (!rawUsage || typeof rawUsage !== "object") {
    return undefined;
  }

  const usage = rawUsage as OpenRouterUsage;
  let inputTokens = parseNonNegativeInteger(usage.prompt_tokens);
  let outputTokens = parseNonNegativeInteger(usage.completion_tokens);
  let totalTokens = parseNonNegativeInteger(usage.total_tokens);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  if (inputTokens === undefined && totalTokens !== undefined && outputTokens !== undefined) {
    inputTokens = Math.max(0, totalTokens - outputTokens);
  }

  if (outputTokens === undefined && totalTokens !== undefined && inputTokens !== undefined) {
    outputTokens = Math.max(0, totalTokens - inputTokens);
  }

  if (inputTokens === undefined) {
    inputTokens = 0;
  }

  if (outputTokens === undefined) {
    outputTokens = 0;
  }

  if (totalTokens === undefined) {
    totalTokens = inputTokens + outputTokens;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly configuredContextWindowTokens?: number;
  private modelContextWindowPromise: null | Promise<number | undefined> = null;
  private readonly model: string;
  private readonly streamByDefault: boolean;

  constructor(config: AgentConfig) {
    this.apiKey = config.llmApiKey;
    this.baseUrl = "https://openrouter.ai/api/v1";
    this.configuredContextWindowTokens = config.contextWindowTokens;
    this.model = config.llmModel;
    this.streamByDefault = config.stream;
  }

  async getModelContextWindowTokens(): Promise<number | undefined> {
    if (this.configuredContextWindowTokens !== undefined) {
      return this.configuredContextWindowTokens;
    }

    if (!this.modelContextWindowPromise) {
      this.modelContextWindowPromise = this.fetchModelContextWindowTokens();
    }

    return this.modelContextWindowPromise;
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
        headers: this.getRequestHeaders(),
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
        usage?: OpenRouterUsage;
      };

      if (data.error) {
        throw new LlmError(`LLM API error: ${data.error.message ?? "Unknown error"}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new LlmError("LLM response missing content");
      }

      return {
        content,
        usage: parseUsage(data.usage),
      };
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
        stream_options: {
          include_usage: true,
        },
      }),
      headers: this.getRequestHeaders(),
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
    let usage: LlmUsage | undefined;

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
          return {
            content,
            usage,
          };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Ignore malformed JSON lines; continue streaming.
          continue;
        }

        const parsedUsage = parseUsage((parsed as { usage?: unknown }).usage);
        if (parsedUsage) {
          usage = parsedUsage;
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

    return {
      content,
      usage,
    };
  }

  private async fetchModelContextWindowTokens(): Promise<number | undefined> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.getRequestHeaders(),
        method: "GET",
      });

      if (!response.ok) {
        log(
          `Unable to resolve model context window from OpenRouter: ${response.status} ${response.statusText}`
        );
        return undefined;
      }

      const payload = (await response.json()) as { data?: OpenRouterModel[] };
      const modelId = this.model.toLowerCase();
      const models = payload.data ?? [];

      const exactMatch = models.find((model) => model.id?.toLowerCase() === modelId);
      if (!exactMatch) {
        log(`OpenRouter model metadata not found for ${this.model}`);
        return undefined;
      }

      const contextWindowTokens = parseNonNegativeInteger(exactMatch.context_length);
      if (contextWindowTokens === undefined || contextWindowTokens === 0) {
        log(`OpenRouter model ${this.model} did not include a valid context length`);
        return undefined;
      }

      return contextWindowTokens;
    } catch (error) {
      log(
        `Failed to resolve model context window: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      return undefined;
    }
  }

  private getRequestHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/zace-agent",
      "X-Title": "Zace CLI Agent",
    };
  }
}
