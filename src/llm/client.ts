import type { AgentConfig } from "../types/config";
import type { LlmRequest, LlmResponse } from "./types";

import { LlmError } from "../utils/errors";
import { log } from "../utils/logger";

export class LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: AgentConfig) {
    this.apiKey = config.llmApiKey;
    this.model = config.llmModel;
    this.baseUrl = "https://openrouter.ai/api/v1";
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    log(`Calling LLM with model: ${this.model}`);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        body: JSON.stringify({
          messages: request.messages,
          model: this.model,
        }),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/forge-agent",
          "X-Title": "Forge CLI Agent",
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
}
