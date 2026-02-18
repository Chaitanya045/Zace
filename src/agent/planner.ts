import { z } from "zod";

import type { LlmClient } from "../llm/client";
import type { LlmMessage, LlmUsage } from "../llm/types";
import type { AgentContext } from "../types/agent";

import { buildPlannerPrompt } from "../prompts/planner";
import { toolCallSchema } from "../types/tool";
import { logStep } from "../utils/logger";

export type PlannerParseMode = "failed" | "legacy" | "repair_json" | "schema_json";

export interface PlanResult {
  action: "ask_user" | "blocked" | "complete" | "continue";
  completionGateCommands?: string[];
  completionGatesDeclaredNone?: boolean;
  parseAttempts: number;
  parseMode: PlannerParseMode;
  rawInvalidCount: number;
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
  plannerParseMaxRepairs?: number;
  plannerParseRetryOnFailure?: boolean;
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

type ParsedPlanResult = Omit<
  PlanResult,
  "parseAttempts" | "parseMode" | "rawInvalidCount" | "usage"
>;

type StrictParseResult =
  | {
      parsed: ParsedPlanResult;
      success: true;
    }
  | {
      reason: string;
      success: false;
    };

const PLANNER_PARSE_FALLBACK_REASONING =
  "I need a clearer task to continue. Please tell me exactly what file/path and outcome you want.";
const PLANNER_PARSE_FALLBACK_USER_MESSAGE =
  "What would you like me to do next? Please include the target file/path and expected outcome.";

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  const toolCallParse = toolCallSchema.safeParse(parsed);
  if (!toolCallParse.success) {
    return null;
  }
  const toolCall = toolCallParse.data;

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

function parsePlannerJsonOnly(content: string): StrictParseResult {
  const jsonPayload = extractJsonPayload(content);
  if (!jsonPayload) {
    return {
      reason: "missing_json_payload",
      success: false,
    };
  }

  const parsedJsonResponse = plannerResponseSchema.safeParse(jsonPayload);
  if (!parsedJsonResponse.success) {
    return {
      reason: parsedJsonResponse.error.message,
      success: false,
    };
  }

  return {
    parsed: toPlanResultFromParsedJson(parsedJsonResponse.data),
    success: true,
  };
}

function parsePlannerLegacy(content: string): ParsedPlanResult | undefined {
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

  const legacyContinue = parseLegacyContinueWithTool(content);
  if (legacyContinue) {
    return legacyContinue;
  }

  return undefined;
}

export function parsePlannerContent(content: string): ParsedPlanResult {
  const strict = parsePlannerJsonOnly(content);
  if (strict.success) {
    return strict.parsed;
  }

  const legacy = parsePlannerLegacy(content);
  if (legacy) {
    return legacy;
  }

  return {
    action: "ask_user",
    reasoning: PLANNER_PARSE_FALLBACK_REASONING,
    userMessage: PLANNER_PARSE_FALLBACK_USER_MESSAGE,
  };
}

function buildPlannerJsonRepairPrompt(previousResponse: string): string {
  const compactResponse = previousResponse.replace(/\s+/gu, " ").trim();
  const preview = compactResponse.length > 1200
    ? `${compactResponse.slice(0, 1200)}...`
    : compactResponse;
  return [
    "Your previous planner response did not match the required strict JSON schema.",
    "Return strict JSON only, exactly matching the schema from the planner prompt.",
    "Do not include markdown, XML tags, or prose outside JSON.",
    `Previous response preview: ${preview}`,
  ].join("\n");
}

function buildPlannerJsonRetryPrompt(previousResponse: string): string {
  const compactResponse = previousResponse.replace(/\s+/gu, " ").trim();
  const preview = compactResponse.length > 800
    ? `${compactResponse.slice(0, 800)}...`
    : compactResponse;
  return [
    "Retry the planner response now.",
    "Output must be strict JSON matching the planner schema and nothing else.",
    "Do not include markdown fences, XML tags, or explanatory text.",
    `Last invalid response preview: ${preview}`,
  ].join("\n");
}

export async function plan(
  client: LlmClient,
  context: AgentContext,
  memory: { getMessages: () => LlmMessage[] },
  options?: PlanOptions
): Promise<PlanResult> {
  logStep(context.currentStep + 1, "Planning next action");

  const prompt = buildPlannerPrompt(context, options?.completionCriteria);
  const baseMessages = [
    ...memory.getMessages(),
    { content: prompt, role: "user" as const },
  ];
  const maxRepairs = Math.max(0, options?.plannerParseMaxRepairs ?? 2);
  const retryOnFailure = options?.plannerParseRetryOnFailure ?? true;

  if (options?.stream) {
    options.onStreamStart?.();
  }
  let response: Awaited<ReturnType<LlmClient["chat"]>>;
  try {
    response = await client.chat(
      { messages: baseMessages },
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

  let usage = response.usage;
  const initialContent = response.content.trim();
  let lastInvalidContent = initialContent;
  let lastInvalidReason = "";
  let parseAttempts = 1;
  let rawInvalidCount = 0;

  const initialStrict = parsePlannerJsonOnly(initialContent);
  if (initialStrict.success) {
    return {
      ...initialStrict.parsed,
      parseAttempts,
      parseMode: "schema_json",
      rawInvalidCount,
      usage,
    };
  }

  rawInvalidCount += 1;
  lastInvalidReason = initialStrict.reason;

  for (let repairAttempt = 0; repairAttempt < maxRepairs; repairAttempt += 1) {
    const repairResponse = await client.chat({
      messages: [
        ...baseMessages,
        { content: lastInvalidContent, role: "assistant" as const },
        { content: buildPlannerJsonRepairPrompt(lastInvalidContent), role: "user" as const },
      ],
    });
    parseAttempts += 1;
    usage = repairResponse.usage ?? usage;

    const repairedContent = repairResponse.content.trim();
    const repairedStrict = parsePlannerJsonOnly(repairedContent);
    if (repairedStrict.success) {
      return {
        ...repairedStrict.parsed,
        parseAttempts,
        parseMode: "repair_json",
        rawInvalidCount,
        usage,
      };
    }

    rawInvalidCount += 1;
    lastInvalidContent = repairedContent;
    lastInvalidReason = repairedStrict.reason;
  }

  if (retryOnFailure) {
    const retryResponse = await client.chat({
      messages: [
        ...baseMessages,
        { content: lastInvalidContent, role: "assistant" as const },
        { content: buildPlannerJsonRetryPrompt(lastInvalidContent), role: "user" as const },
      ],
    });
    parseAttempts += 1;
    usage = retryResponse.usage ?? usage;

    const retryContent = retryResponse.content.trim();
    const retryStrict = parsePlannerJsonOnly(retryContent);
    if (retryStrict.success) {
      return {
        ...retryStrict.parsed,
        parseAttempts,
        parseMode: "repair_json",
        rawInvalidCount,
        usage,
      };
    }

    rawInvalidCount += 1;
    lastInvalidContent = retryContent;
    lastInvalidReason = retryStrict.reason;
  }

  const legacy = parsePlannerLegacy(lastInvalidContent) ?? parsePlannerLegacy(initialContent);
  if (legacy) {
    return {
      ...legacy,
      parseAttempts,
      parseMode: "legacy",
      rawInvalidCount,
      usage,
    };
  }

  const failureMessage =
    `Planner output parsing failed after ${String(parseAttempts)} attempts. ` +
    `Expected strict JSON matching planner schema. Last parse reason: ${lastInvalidReason || "unknown_parse_error"}.`;
  return {
    action: "blocked",
    parseAttempts,
    parseMode: "failed",
    rawInvalidCount,
    reasoning: failureMessage,
    usage,
    userMessage: "Planner response was malformed repeatedly. Please retry the request.",
  };
}
