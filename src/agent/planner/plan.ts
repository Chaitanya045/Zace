import type { PlannerOutputMode } from "../../config/env";
import type { LlmClient } from "../../llm/client";
import type { LlmMessage, LlmUsage } from "../../llm/types";
import type { AgentContext } from "../../types/agent";

import { buildPlannerPrompt } from "../../prompts/planner";
import { LlmError } from "../../utils/errors";
import { logStep } from "../../utils/logger";
import { PLANNER_RESPONSE_JSON_SCHEMA } from "../planner-schema";
import { persistInvalidPlannerOutputArtifact, type InvalidPlannerAttempt } from "./invalid-artifacts";
import {
  parsePlannerContent,
  parsePlannerJsonOnly,
  parsePlannerLegacy,
  type ParsedPlanResult,
} from "./parser";
import { buildPlannerJsonRepairPrompt, buildPlannerJsonRetryPrompt } from "./repair";

export type PlannerParseMode = "failed" | "legacy" | "repair_json" | "schema_transport";

export interface PlanResult {
  action: "ask_user" | "blocked" | "complete" | "continue";
  completionGateCommands?: string[];
  completionGatesDeclaredNone?: boolean;
  invalidOutputArtifactPath?: string;
  llmRequestNormalizationReasons?: string[];
  llmRequestNormalized?: boolean;
  llmRequestRejected?: boolean;
  parseAttempts: number;
  parseMode: PlannerParseMode;
  plannerFallbackPromptMode?: boolean;
  rawInvalidCount: number;
  reasoning: string;
  schemaUnsupportedReason?: string;
  toolCall?: { arguments: Record<string, unknown>; name: string };
  transportStructured: boolean;
  usage?: LlmUsage;
  userMessage?: string;
}

type PlanOptions = {
  completionCriteria?: string[];
  onStreamEnd?: () => void;
  onStreamStart?: () => void;
  onStreamToken?: (token: string) => void;
  plannerMaxInvalidArtifactChars?: number;
  plannerOutputMode?: PlannerOutputMode;
  plannerParseMaxRepairs?: number;
  plannerParseRetryOnFailure?: boolean;
  plannerSchemaStrict?: boolean;
  stream?: boolean;
};

function getSchemaUnsupportedReason(error: unknown): string | undefined {
  if (!(error instanceof LlmError)) {
    return undefined;
  }

  if (!error.responseFormatUnsupported) {
    return undefined;
  }

  return (
    error.providerMessage ||
    error.message ||
    "Model/provider does not support JSON schema response_format for planner output."
  );
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
  const plannerOutputMode = options?.plannerOutputMode ?? "auto";
  const plannerSchemaStrict = options?.plannerSchemaStrict ?? true;
  const maxInvalidArtifactChars = Math.max(200, options?.plannerMaxInvalidArtifactChars ?? 4_000);
  const maxRepairs = Math.max(0, options?.plannerParseMaxRepairs ?? 2);
  const retryOnFailure = options?.plannerParseRetryOnFailure ?? true;

  let usage: LlmUsage | undefined;
  let llmRequestNormalized = false;
  const llmRequestNormalizationReasons = new Set<string>();
  let llmRequestRejected = false;
  let plannerFallbackPromptMode = false;
  let parseAttempts = 0;
  let rawInvalidCount = 0;
  let schemaUnsupportedReason: string | undefined;
  let lastInvalidContent = "";
  let lastInvalidReason = "";
  const invalidAttempts: InvalidPlannerAttempt[] = [];

  const recordInvalid = (
    content: string,
    parseReason: string,
    input: {
      transportStructured: boolean;
    }
  ): void => {
    rawInvalidCount += 1;
    lastInvalidContent = content;
    lastInvalidReason = parseReason;
    invalidAttempts.push({
      content,
      parseReason,
      transportStructured: input.transportStructured,
    });
  };

  const invokePlannerModel = async (
    input: {
      forceNormalizeToolRole?: boolean;
      stream: boolean;
      transportStructured: boolean;
    }
  ): Promise<Awaited<ReturnType<LlmClient["chat"]>>> => {
    if (input.stream) {
      options?.onStreamStart?.();
    }
    try {
      parseAttempts += 1;
      return await client.chat(
        {
          callKind: "planner",
          messages: baseMessages,
          ...(input.forceNormalizeToolRole ? { normalizeToolRole: true } : {}),
          ...(input.transportStructured
            ? {
                responseFormat: {
                  name: "zace_planner_decision",
                  schema: PLANNER_RESPONSE_JSON_SCHEMA,
                  strict: plannerSchemaStrict,
                  type: "json_schema" as const,
                },
              }
            : {}),
        },
        input.stream
          ? {
              onToken: (token) => {
                options?.onStreamToken?.(token);
              },
              stream: true,
            }
          : undefined
      );
    } finally {
      if (input.stream) {
        options?.onStreamEnd?.();
      }
    }
  };

  if (plannerOutputMode !== "prompt_only") {
    try {
      const transportResponse = await invokePlannerModel({
        stream: options?.stream ?? false,
        transportStructured: true,
      });
      if (transportResponse.normalized?.reasons && transportResponse.normalized.reasons.length > 0) {
        llmRequestNormalized = true;
        for (const reason of transportResponse.normalized.reasons) {
          llmRequestNormalizationReasons.add(reason);
        }
      }
      usage = transportResponse.usage ?? usage;
      const transportContent = transportResponse.content.trim();
      const transportStrict = parsePlannerJsonOnly(transportContent);
      if (transportStrict.success) {
        return {
          ...transportStrict.parsed,
          llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
          llmRequestNormalized,
          llmRequestRejected,
          parseAttempts,
          parseMode: "schema_transport",
          rawInvalidCount,
          transportStructured: true,
          usage,
        };
      }

      recordInvalid(transportContent, transportStrict.reason, {
        transportStructured: true,
      });
      if (plannerOutputMode === "schema_strict") {
        const invalidOutputArtifactPath = await persistInvalidPlannerOutputArtifact({
          attempts: invalidAttempts,
          maxChars: maxInvalidArtifactChars,
          outputMode: plannerOutputMode,
        });
        const strictFailureMessage =
          `Planner structured output was invalid. Last parse reason: ${lastInvalidReason || "unknown_parse_error"}.` +
          `${invalidOutputArtifactPath ? ` Invalid output artifact: ${invalidOutputArtifactPath}.` : ""}`;
        return {
          action: "blocked",
          invalidOutputArtifactPath,
          llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
          llmRequestNormalized,
          llmRequestRejected,
          parseAttempts,
          parseMode: "failed",
          plannerFallbackPromptMode,
          rawInvalidCount,
          reasoning: strictFailureMessage,
          transportStructured: true,
          usage,
          userMessage:
            "Planner response was malformed in strict schema mode. Please retry with a model that supports strict JSON schema output.",
        };
      }
    } catch (error) {
      if (error instanceof LlmError && error.errorClass === "invalid_message_shape") {
        llmRequestRejected = true;
        const retryResponse = await invokePlannerModel({
          forceNormalizeToolRole: true,
          stream: false,
          transportStructured: true,
        });
        if (retryResponse.normalized?.reasons && retryResponse.normalized.reasons.length > 0) {
          llmRequestNormalized = true;
          for (const reason of retryResponse.normalized.reasons) {
            llmRequestNormalizationReasons.add(reason);
          }
        }
        usage = retryResponse.usage ?? usage;
        const retryContent = retryResponse.content.trim();
        const retryStrict = parsePlannerJsonOnly(retryContent);
        if (retryStrict.success) {
          return {
            ...retryStrict.parsed,
            llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
            llmRequestNormalized,
            llmRequestRejected,
            parseAttempts,
            parseMode: "schema_transport",
            rawInvalidCount,
            transportStructured: true,
            usage,
          };
        }

        recordInvalid(retryContent, retryStrict.reason, {
          transportStructured: true,
        });
        if (plannerOutputMode === "schema_strict") {
          const invalidOutputArtifactPath = await persistInvalidPlannerOutputArtifact({
            attempts: invalidAttempts,
            maxChars: maxInvalidArtifactChars,
            outputMode: plannerOutputMode,
          });
          const strictFailureMessage =
            `Planner structured output was invalid. Last parse reason: ${lastInvalidReason || "unknown_parse_error"}.` +
            `${invalidOutputArtifactPath ? ` Invalid output artifact: ${invalidOutputArtifactPath}.` : ""}`;
          return {
            action: "blocked",
            invalidOutputArtifactPath,
            llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
            llmRequestNormalized,
            llmRequestRejected,
            parseAttempts,
            parseMode: "failed",
            plannerFallbackPromptMode,
            rawInvalidCount,
            reasoning: strictFailureMessage,
            transportStructured: true,
            usage,
            userMessage:
              "Planner response was malformed in strict schema mode. Please retry with a model that supports strict JSON schema output.",
          };
        }
      }

      const unsupportedReason = getSchemaUnsupportedReason(error);
      if (!unsupportedReason) {
        throw error;
      }

      schemaUnsupportedReason = unsupportedReason;
      plannerFallbackPromptMode = true;
      if (plannerOutputMode === "schema_strict") {
        return {
          action: "blocked",
          llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
          llmRequestNormalized,
          llmRequestRejected,
          parseAttempts,
          parseMode: "failed",
          plannerFallbackPromptMode,
          rawInvalidCount,
          reasoning:
            `Planner structured output mode is required but unsupported by the provider/model. ${unsupportedReason}`,
          schemaUnsupportedReason: unsupportedReason,
          transportStructured: true,
          usage,
          userMessage:
            "Planner schema mode is unsupported by this model/provider. Please switch models or disable strict planner schema mode.",
        };
      }
    }
  }

  let initialContent = lastInvalidContent;
  if (plannerOutputMode !== "prompt_only") {
    plannerFallbackPromptMode = true;
  }
  if (!initialContent) {
    const promptResponse = await invokePlannerModel({
      stream: (options?.stream ?? false) && parseAttempts === 0,
      transportStructured: false,
    });
    if (promptResponse.normalized?.reasons && promptResponse.normalized.reasons.length > 0) {
      llmRequestNormalized = true;
      for (const reason of promptResponse.normalized.reasons) {
        llmRequestNormalizationReasons.add(reason);
      }
    }
    usage = promptResponse.usage ?? usage;
    initialContent = promptResponse.content.trim();
    const initialStrict = parsePlannerJsonOnly(initialContent);
    if (initialStrict.success) {
      return {
        ...initialStrict.parsed,
        llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
        llmRequestNormalized,
        llmRequestRejected,
        parseAttempts,
        parseMode: "repair_json",
        plannerFallbackPromptMode,
        rawInvalidCount,
        schemaUnsupportedReason,
        transportStructured: false,
        usage,
      };
    }

    recordInvalid(initialContent, initialStrict.reason, {
      transportStructured: false,
    });
  }

  for (let repairAttempt = 0; repairAttempt < maxRepairs; repairAttempt += 1) {
    const repairResponse = await client.chat({
      callKind: "planner",
      messages: [
        ...baseMessages,
        { content: lastInvalidContent, role: "assistant" as const },
        { content: buildPlannerJsonRepairPrompt(lastInvalidContent), role: "user" as const },
      ],
    });
    if (repairResponse.normalized?.reasons && repairResponse.normalized.reasons.length > 0) {
      llmRequestNormalized = true;
      for (const reason of repairResponse.normalized.reasons) {
        llmRequestNormalizationReasons.add(reason);
      }
    }
    parseAttempts += 1;
    usage = repairResponse.usage ?? usage;

    const repairedContent = repairResponse.content.trim();
    const repairedStrict = parsePlannerJsonOnly(repairedContent);
    if (repairedStrict.success) {
      return {
        ...repairedStrict.parsed,
        llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
        llmRequestNormalized,
        llmRequestRejected,
        parseAttempts,
        parseMode: "repair_json",
        plannerFallbackPromptMode,
        rawInvalidCount,
        schemaUnsupportedReason,
        transportStructured: false,
        usage,
      };
    }

    recordInvalid(repairedContent, repairedStrict.reason, {
      transportStructured: false,
    });
  }

  if (retryOnFailure) {
    const retryResponse = await client.chat({
      callKind: "planner",
      messages: [
        ...baseMessages,
        { content: lastInvalidContent, role: "assistant" as const },
        { content: buildPlannerJsonRetryPrompt(lastInvalidContent), role: "user" as const },
      ],
    });
    if (retryResponse.normalized?.reasons && retryResponse.normalized.reasons.length > 0) {
      llmRequestNormalized = true;
      for (const reason of retryResponse.normalized.reasons) {
        llmRequestNormalizationReasons.add(reason);
      }
    }
    parseAttempts += 1;
    usage = retryResponse.usage ?? usage;

    const retryContent = retryResponse.content.trim();
    const retryStrict = parsePlannerJsonOnly(retryContent);
    if (retryStrict.success) {
      return {
        ...retryStrict.parsed,
        llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
        llmRequestNormalized,
        llmRequestRejected,
        parseAttempts,
        parseMode: "repair_json",
        plannerFallbackPromptMode,
        rawInvalidCount,
        schemaUnsupportedReason,
        transportStructured: false,
        usage,
      };
    }

    recordInvalid(retryContent, retryStrict.reason, {
      transportStructured: false,
    });
  }

  const legacy = parsePlannerLegacy(lastInvalidContent) ?? parsePlannerLegacy(initialContent);
  if (legacy) {
    return {
      ...legacy,
      llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
      llmRequestNormalized,
      llmRequestRejected,
      parseAttempts,
      parseMode: "legacy",
      plannerFallbackPromptMode,
      rawInvalidCount,
      schemaUnsupportedReason,
      transportStructured: false,
      usage,
    };
  }

  const invalidOutputArtifactPath = await persistInvalidPlannerOutputArtifact({
    attempts: invalidAttempts,
    maxChars: maxInvalidArtifactChars,
    outputMode: plannerOutputMode,
  });
  const failureMessage =
    `Planner output parsing failed after ${String(parseAttempts)} attempts. ` +
    `Expected strict JSON matching planner schema. Last parse reason: ${lastInvalidReason || "unknown_parse_error"}.` +
    `${invalidOutputArtifactPath ? ` Invalid output artifact: ${invalidOutputArtifactPath}.` : ""}`;
  return {
    action: "blocked",
    invalidOutputArtifactPath,
    llmRequestNormalizationReasons: Array.from(llmRequestNormalizationReasons),
    llmRequestNormalized,
    llmRequestRejected,
    parseAttempts,
    parseMode: "failed",
    plannerFallbackPromptMode,
    rawInvalidCount,
    reasoning: failureMessage,
    schemaUnsupportedReason,
    transportStructured: false,
    usage,
    userMessage: invalidOutputArtifactPath
      ? `Planner response was malformed repeatedly. Inspect ${invalidOutputArtifactPath} and retry.`
      : "Planner response was malformed repeatedly. Please retry the request.",
  };
}

export { parsePlannerContent, type ParsedPlanResult };
