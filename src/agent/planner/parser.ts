import {
  plannerResponseSchema,
  plannerToolCallSchema,
  type PlannerStructuredResponse,
} from "./schema";

export type ParsedPlanResult = {
  action: "ask_user" | "blocked" | "complete" | "continue";
  completionGateCommands?: string[];
  completionGatesDeclaredNone?: boolean;
  reasoning: string;
  toolCall?: { arguments: Record<string, unknown>; name: string };
  userMessage?: string;
};

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
  const toolCallParse = plannerToolCallSchema.safeParse(parsed);
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

function toPlanResultFromParsedJson(parsed: PlannerStructuredResponse): ParsedPlanResult {
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

export function parsePlannerJsonOnly(content: string): StrictParseResult {
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

export function parsePlannerLegacy(content: string): ParsedPlanResult | undefined {
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
