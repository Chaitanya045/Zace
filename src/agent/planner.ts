import { z } from "zod";

import type { LlmClient } from "../llm/client";
import type { LlmMessage, LlmUsage } from "../llm/types";
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
  userMessage?: string;
  toolCall?: { arguments: Record<string, unknown>; name: string };
  usage?: LlmUsage;
}

type PlanOptions = {
  completionCriteria?: string[];
  onStreamEnd?: () => void;
  onStreamStart?: () => void;
  onStreamToken?: (token: string) => void;
  stream?: boolean;
};

const plannerCompleteResponseSchema = z.object({
  action: z.literal("complete"),
  gates: z.union([z.array(z.string().min(1)), z.literal("none")]).optional(),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

const plannerContinueResponseSchema = z.object({
  action: z.literal("continue"),
  reasoning: z.string().min(1),
  toolCall: toolCallSchema,
});

const plannerAskUserResponseSchema = z.object({
  action: z.literal("ask_user"),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

const plannerBlockedResponseSchema = z.object({
  action: z.literal("blocked"),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

const plannerResponseSchema = z.union([
  plannerContinueResponseSchema,
  plannerCompleteResponseSchema,
  plannerAskUserResponseSchema,
  plannerBlockedResponseSchema,
]);

type ParsedPlanResult = Omit<PlanResult, "usage">;

function parseLegacyComplete(content: string): null | ParsedPlanResult {
  if (!content.toUpperCase().includes("COMPLETE:")) {
    return null;
  }

  const completionBody = content.replace(/^.*?COMPLETE:/isu, "").trim();
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

function parseLegacyAskUser(content: string): null | ParsedPlanResult {
  const askUserMatch = content.match(/ASK_USER:\s*([\s\S]+)/iu);
  if (!askUserMatch) {
    return null;
  }

  const userMessage = askUserMatch[1]?.trim() || "What concrete task should I perform?";
  return {
    action: "ask_user",
    reasoning: userMessage,
    userMessage,
  };
}

function parseLegacyBlocked(content: string): null | ParsedPlanResult {
  const blockedMatch = content.match(/BLOCKED:\s*([\s\S]+)/iu);
  if (!blockedMatch) {
    return null;
  }

  const userMessage = blockedMatch[1]?.trim() || "Blocked without a clear reason.";
  return {
    action: "blocked",
    reasoning: userMessage,
    userMessage,
  };
}

function parseLegacyContinueWithTool(content: string): null | ParsedPlanResult {
  const jsonMatch = content.match(/\{[\s\S]*\}/u);
  if (!jsonMatch) {
    return null;
  }

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
}

function toPlanResultFromParsedJson(parsed: z.infer<typeof plannerResponseSchema>): ParsedPlanResult {
  if (parsed.action === "continue") {
    return {
      action: "continue",
      reasoning: parsed.reasoning,
      toolCall: {
        arguments: parsed.toolCall.arguments,
        name: parsed.toolCall.name,
      },
    };
  }

  if (parsed.action === "ask_user") {
    return {
      action: "ask_user",
      reasoning: parsed.reasoning,
      userMessage: parsed.userMessage,
    };
  }

  if (parsed.action === "blocked") {
    return {
      action: "blocked",
      reasoning: parsed.reasoning,
      userMessage: parsed.userMessage,
    };
  }

  if (parsed.gates === "none") {
    return {
      action: "complete",
      completionGateCommands: [],
      completionGatesDeclaredNone: true,
      reasoning: parsed.reasoning,
      userMessage: parsed.userMessage,
    };
  }

  return {
    action: "complete",
    completionGateCommands: parsed.gates ?? [],
    completionGatesDeclaredNone: false,
    reasoning: parsed.reasoning,
    userMessage: parsed.userMessage,
  };
}

function extractJsonPayload(content: string): null | unknown {
  const trimmedContent = content.trim();

  try {
    return JSON.parse(trimmedContent);
  } catch {
    // Keep trying alternative extraction formats.
  }

  const fencedJsonMatch = trimmedContent.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedJsonMatch?.[1]) {
    try {
      return JSON.parse(fencedJsonMatch[1]);
    } catch {
      // Keep trying.
    }
  }

  const jsonMatch = trimmedContent.match(/\{[\s\S]*\}/u);
  if (jsonMatch?.[0]) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }

  return null;
}

export function parsePlannerContent(content: string): ParsedPlanResult {
  const jsonPayload = extractJsonPayload(content);
  if (jsonPayload) {
    const parsedJsonResponse = plannerResponseSchema.safeParse(jsonPayload);
    if (parsedJsonResponse.success) {
      return toPlanResultFromParsedJson(parsedJsonResponse.data);
    }
  }

  const legacyComplete = parseLegacyComplete(content);
  if (legacyComplete) {
    return legacyComplete;
  }

  const legacyAskUser = parseLegacyAskUser(content);
  if (legacyAskUser) {
    return legacyAskUser;
  }

  const legacyBlocked = parseLegacyBlocked(content);
  if (legacyBlocked) {
    return legacyBlocked;
  }

  try {
    const legacyContinue = parseLegacyContinueWithTool(content);
    if (legacyContinue) {
      return legacyContinue;
    }
  } catch (error) {
    throw new ValidationError(
      `Failed to parse tool call from planner response: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }

  return {
    action: "ask_user",
    reasoning:
      "I need a clearer task to continue. Please tell me exactly what file/path and outcome you want.",
    userMessage:
      "What would you like me to do next? Please include the target file/path and expected outcome.",
  };
}

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
    options.onStreamStart?.();
  }
  let response: Awaited<ReturnType<LlmClient["chat"]>>;
  try {
    response = await client.chat(
      { messages },
      options?.stream
        ? {
            onToken: (token) => {
              options.onStreamToken?.(token);
            },
            stream: true,
          }
        : undefined
    );
  } finally {
    if (options?.stream) {
      options.onStreamEnd?.();
    }
  }
  const content = response.content.trim();
  const usage = response.usage;
  const parsedResult = parsePlannerContent(content);
  return {
    ...parsedResult,
    usage,
  };
}
