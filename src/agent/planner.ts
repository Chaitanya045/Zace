import type { LlmClient } from "../llm/client";
import type { LlmMessage } from "../llm/types";
import type { AgentContext } from "../types/agent";

import { buildPlannerPrompt } from "../prompts/planner";
import { buildSystemPrompt } from "../prompts/system";
import { allTools } from "../tools";
import { toolCallSchema } from "../types/tool";
import { ValidationError } from "../utils/errors";
import { logStep } from "../utils/logger";

export interface PlanResult {
  action: "blocked" | "complete" | "continue";
  reasoning: string;
  toolCall?: { arguments: Record<string, unknown>; name: string };
}

type PlanOptions = {
  stream?: boolean;
};

export async function plan(
  client: LlmClient,
  context: AgentContext,
  memory: { getMessages: () => LlmMessage[] },
  options?: PlanOptions
): Promise<PlanResult> {
  logStep(context.currentStep + 1, "Planning next action");

  const prompt = buildPlannerPrompt(context);
  
  // Build dynamic system prompt for planning context
  const systemPrompt = buildSystemPrompt({
    availableTools: allTools.map((tool) => tool.name),
    currentDirectory: process.cwd(),
    maxSteps: context.maxSteps,
  });

  const messages = [
    { content: systemPrompt, role: "system" as const },
    ...memory.getMessages(),
    { content: prompt, role: "user" as const },
  ];

  if (options?.stream) {
    process.stdout.write("\n\n[LLM:planner]\n");
  }
  const response = await client.chat(
    { messages },
    options?.stream
      ? {
          onToken: (token) => {
            process.stdout.write(token);
          },
          stream: true,
        }
      : undefined
  );
  if (options?.stream) {
    process.stdout.write("\n");
  }
  const content = response.content.trim();

  // Parse the response
  if (content.startsWith("COMPLETE:")) {
    return {
      action: "complete",
      reasoning: content.replace("COMPLETE:", "").trim(),
    };
  }

  if (content.startsWith("BLOCKED:")) {
    return {
      action: "blocked",
      reasoning: content.replace("BLOCKED:", "").trim(),
    };
  }

  // Try to extract tool call from JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const toolCall = toolCallSchema.parse(parsed);

      return {
        action: "continue",
        reasoning: content.split("{")[0]?.replace("CONTINUE:", "").trim() || "Executing tool",
        toolCall: {
          arguments: toolCall.arguments,
          name: toolCall.name,
        },
      };
    } catch (error) {
      throw new ValidationError(
        `Failed to parse tool call from planner response: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  // Default to continue with reasoning
  return {
    action: "continue",
    reasoning: content,
  };
}
