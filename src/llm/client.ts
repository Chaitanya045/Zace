import type { AgentConfig } from "../types/config";
import type { LlmRequest, LlmResponse, LlmUsage } from "./types";

import { LlmError } from "../utils/errors";
import { log } from "../utils/logger";
import { classifyProviderError, normalizeMessagesForTransport } from "./compat";

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

type OpenRouterChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { code?: number | string; message?: string };
  usage?: OpenRouterUsage;
};

type ParsedProviderError = {
  errorClass: "invalid_message_shape" | "other" | "rate_limit" | "response_format_unsupported";
  providerCode?: string;
  providerMessage?: string;
  responseBody?: string;
  responseFormatUnsupported: boolean;
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

function normalizeProviderCode(code: unknown): string | undefined {
  if (typeof code !== "number" && typeof code !== "string") {
    return undefined;
  }

  const normalized = String(code).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isResponseFormatUnsupported(input: {
  providerCode?: string;
  providerMessage?: string;
}): boolean {
  const haystack = `${input.providerCode ?? ""} ${input.providerMessage ?? ""}`.toLowerCase();
  if (!haystack) {
    return false;
  }

  return (
    (haystack.includes("response_format") || haystack.includes("json_schema")) &&
    (haystack.includes("unsupported") ||
      haystack.includes("not supported") ||
      haystack.includes("invalid"))
  );
}

function parseProviderError(rawBody: string, statusCode?: number): ParsedProviderError {
  const fallbackMessage = rawBody.trim();
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: {
        code?: number | string;
        message?: string;
      };
    };
    const providerCode = normalizeProviderCode(parsed.error?.code);
    const providerMessage = parsed.error?.message?.trim() || fallbackMessage || undefined;
    const responseFormatUnsupported = isResponseFormatUnsupported({
      providerCode,
      providerMessage,
    });
    return {
      errorClass: classifyProviderError({
        providerCode,
        providerMessage,
        responseFormatUnsupported,
        statusCode,
      }),
      providerCode,
      providerMessage,
      responseBody: fallbackMessage || undefined,
      responseFormatUnsupported,
    };
  } catch {
    const providerMessage = fallbackMessage || undefined;
    const responseFormatUnsupported = isResponseFormatUnsupported({
      providerMessage,
    });
    return {
      errorClass: classifyProviderError({
        providerMessage,
        responseFormatUnsupported,
        statusCode,
      }),
      providerMessage,
      responseBody: fallbackMessage || undefined,
      responseFormatUnsupported,
    };
  }
}

function buildResponseFormat(request: LlmRequest): Record<string, unknown> | undefined {
  if (!request.responseFormat || request.responseFormat.type !== "json_schema") {
    return undefined;
  }

  return {
    json_schema: {
      name: request.responseFormat.name,
      schema: request.responseFormat.schema,
      strict: request.responseFormat.strict,
    },
    type: "json_schema",
  };
}

function buildChatRequestBody(
  model: string,
  request: LlmRequest,
  input: {
    stream: boolean;
  }
): Record<string, unknown> {
  const responseFormat = buildResponseFormat(request);
  return {
    messages: request.messages,
    model,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(input.stream
      ? {
        stream: true,
        stream_options: {
          include_usage: true,
        },
      }
      : {}),
  };
}

export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly configuredContextWindowTokens?: number;
  private modelContextWindowPromise: null | Promise<number | undefined> = null;
  private readonly model: string;
  private readonly normalizeToolRoleByDefault: boolean;
  private readonly streamByDefault: boolean;

  constructor(config: AgentConfig) {
    this.apiKey = config.llmApiKey;
    this.baseUrl = "https://openrouter.ai/api/v1";
    this.configuredContextWindowTokens = config.contextWindowTokens;
    this.model = config.llmModel;
    this.normalizeToolRoleByDefault = config.llmCompatNormalizeToolRole;
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
      const transportRequest = this.normalizeRequestForTransport(request);
      const shouldStream = options?.stream ?? this.streamByDefault;

      if (shouldStream) {
        const streamResponse = await this.chatStream(transportRequest.request, options?.onToken);
        if (transportRequest.reasons.length === 0) {
          return streamResponse;
        }
        return {
          ...streamResponse,
          normalized: {
            reasons: transportRequest.reasons,
          },
        };
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        body: JSON.stringify(buildChatRequestBody(this.model, transportRequest.request, { stream: false })),
        headers: this.getRequestHeaders(),
        method: "POST",
      });

      if (!response.ok) {
        const errorText = await response.text();
        const parsedError = parseProviderError(errorText, response.status);
        throw new LlmError(
          `LLM API request failed: ${response.status} ${response.statusText}. ${parsedError.providerMessage ?? "Unknown provider error"}`,
          undefined,
          {
            errorClass: parsedError.errorClass,
            providerCode: parsedError.providerCode,
            providerMessage: parsedError.providerMessage,
            responseBody: parsedError.responseBody,
            responseFormatUnsupported: parsedError.responseFormatUnsupported,
            statusCode: response.status,
          }
        );
      }

      const data = (await response.json()) as OpenRouterChatResponse;

      if (data.error) {
        const providerCode = normalizeProviderCode(data.error.code);
        const providerMessage = data.error.message ?? "Unknown error";
        throw new LlmError(`LLM API error: ${providerMessage}`, undefined, {
          errorClass: classifyProviderError({
            providerCode,
            providerMessage,
          }),
          providerCode,
          providerMessage,
          responseFormatUnsupported: isResponseFormatUnsupported({
            providerCode,
            providerMessage,
          }),
        });
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new LlmError("LLM response missing content");
      }

      const llmResponse: LlmResponse = {
        content,
        usage: parseUsage(data.usage),
      };
      if (transportRequest.reasons.length > 0) {
        llmResponse.normalized = {
          reasons: transportRequest.reasons,
        };
      }
      return llmResponse;
    } catch (error) {
      if (error instanceof LlmError) {
        throw error;
      }
      throw new LlmError(`Failed to call LLM: ${error instanceof Error ? error.message : "Unknown error"}`, error);
    }
  }

  private async chatStream(request: LlmRequest, onToken?: (token: string) => void): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      body: JSON.stringify(buildChatRequestBody(this.model, request, { stream: true })),
      headers: this.getRequestHeaders(),
      method: "POST",
    });

    if (!response.ok) {
      const errorText = await response.text();
      const parsedError = parseProviderError(errorText, response.status);
      throw new LlmError(
        `LLM API request failed: ${response.status} ${response.statusText}. ${parsedError.providerMessage ?? "Unknown provider error"}`,
        undefined,
        {
          errorClass: parsedError.errorClass,
          providerCode: parsedError.providerCode,
          providerMessage: parsedError.providerMessage,
          responseBody: parsedError.responseBody,
          responseFormatUnsupported: parsedError.responseFormatUnsupported,
          statusCode: response.status,
        }
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

  private normalizeRequestForTransport(request: LlmRequest): {
    reasons: string[];
    request: LlmRequest;
  } {
    const normalizedMessages = normalizeMessagesForTransport({
      callKind: request.callKind,
      messages: request.messages,
      normalizeToolRole: request.normalizeToolRole ?? this.normalizeToolRoleByDefault,
    });

    if (!normalizedMessages.changed) {
      return {
        reasons: [],
        request,
      };
    }

    return {
      reasons: normalizedMessages.reasons,
      request: {
        ...request,
        messages: normalizedMessages.messages,
      },
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
