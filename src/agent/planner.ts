import type { LlmClient } from "../llm/client";
import type { LlmMessage } from "../llm/types";
import type { AgentContext } from "../types/agent";

import { buildPlannerPrompt } from "../prompts/planner";
import { toolCallSchema } from "../types/tool";
import { ValidationError } from "../utils/errors";
import { logStep } from "../utils/logger";

export interface PlanResult {
  action: "ask_user" | "blocked" | "complete" | "continue";
  completionGateCommands?: string[];
  completionGatesDeclaredNone?: boolean;
  reasoning: string;
  toolCall?: { arguments: Record<string, unknown>; name: string };
}

type PlanOptions = {
  completionCriteria?: string[];
  stream?: boolean;
};

export async function plan(
  client: LlmClient,
  context: AgentContext,
  memory: { getMessages: () => LlmMessage[] },
  options?: PlanOptions
): Promise<PlanResult> {
  logStep(context.currentStep + 1, "Planning next action");

  const prompt = buildPlannerPrompt(context, options?.completionCriteria);

  const messages = [
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
    const completionBody = content.replace("COMPLETE:", "").trim();
    const completionGateCommands: string[] = [];
    let completionGatesDeclaredNone = false;
    const reasoningLines: string[] = [];

    for (const line of completionBody.split(/\r?\n/u)) {
      const trimmedLine = line.trim();
      if (!trimmedLine.toUpperCase().startsWith("GATES:")) {
        reasoningLines.push(line);
        continue;
      }

      const gateCommandsRaw = trimmedLine.slice("GATES:".length).trim();
      if (!gateCommandsRaw) {
        continue;
      }

      if (gateCommandsRaw.toLowerCase() === "none") {
        completionGatesDeclaredNone = true;
        continue;
      }

      const parsedGateCommands = gateCommandsRaw
        .split(";;")
        .map((command) => command.trim())
        .filter((command) => command.length > 0);
      completionGateCommands.push(...parsedGateCommands);
    }

    const reasoning = reasoningLines.join("\n").trim() || "Task complete";

    return {
      action: "complete",
      completionGateCommands,
      completionGatesDeclaredNone,
      reasoning,
    };
  }

  if (content.startsWith("BLOCKED:")) {
    return {
      action: "blocked",
      reasoning: content.replace("BLOCKED:", "").trim(),
    };
  }

  if (content.startsWith("ASK_USER:")) {
    return {
      action: "ask_user",
      reasoning: content.replace("ASK_USER:", "").trim(),
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
