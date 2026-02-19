import type { AgentConfig } from "../../../types/config";
import type { AgentObserver } from "../../observer";
import type { PlanResult } from "../../planner/plan";

import { appendRunEvent } from "./run-events";

type EmitPlannerTelemetryInput = {
  config: AgentConfig;
  observer?: AgentObserver;
  planResult: PlanResult;
  runId: string;
  sessionId?: string;
  stepNumber: number;
};

export async function emitPlannerTelemetry(input: EmitPlannerTelemetryInput): Promise<void> {
  const { config, observer, planResult, runId, sessionId, stepNumber } = input;

  if (planResult.schemaUnsupportedReason) {
    await appendRunEvent({
      event: "planner_schema_unsupported",
      observer,
      payload: {
        parseMode: planResult.parseMode,
        reason: planResult.schemaUnsupportedReason,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  if (planResult.llmRequestNormalized) {
    await appendRunEvent({
      event: "llm_request_normalized",
      observer,
      payload: {
        parseMode: planResult.parseMode,
        reasons: planResult.llmRequestNormalizationReasons ?? [],
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  if (planResult.llmRequestRejected) {
    await appendRunEvent({
      event: "llm_request_rejected",
      observer,
      payload: {
        parseMode: planResult.parseMode,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  if (planResult.plannerFallbackPromptMode) {
    await appendRunEvent({
      event: "planner_fallback_prompt_mode",
      observer,
      payload: {
        outputMode: config.plannerOutputMode ?? "auto",
        parseMode: planResult.parseMode,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  if (planResult.invalidOutputArtifactPath) {
    await appendRunEvent({
      event: "planner_invalid_output_captured",
      observer,
      payload: {
        artifactPath: planResult.invalidOutputArtifactPath,
        rawInvalidCount: planResult.rawInvalidCount,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  if (planResult.rawInvalidCount > 0) {
    await appendRunEvent({
      event: "planner_parse_failed",
      observer,
      payload: {
        parseAttempts: planResult.parseAttempts,
        parseMode: planResult.parseMode,
        rawInvalidCount: planResult.rawInvalidCount,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  if (planResult.parseAttempts > 1) {
    await appendRunEvent({
      event: "planner_parse_repair_attempted",
      observer,
      payload: {
        parseAttempts: planResult.parseAttempts,
        parseMode: planResult.parseMode,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  if (planResult.parseMode === "repair_json" || planResult.parseMode === "legacy") {
    await appendRunEvent({
      event: "planner_parse_recovered",
      observer,
      payload: {
        parseAttempts: planResult.parseAttempts,
        parseMode: planResult.parseMode,
        rawInvalidCount: planResult.rawInvalidCount,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  if (planResult.parseMode === "failed") {
    await appendRunEvent({
      event: "planner_parse_exhausted",
      observer,
      payload: {
        parseAttempts: planResult.parseAttempts,
        rawInvalidCount: planResult.rawInvalidCount,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
    await appendRunEvent({
      event: "planner_blocked_parse_exhausted",
      observer,
      payload: {
        invalidOutputArtifactPath: planResult.invalidOutputArtifactPath,
        parseAttempts: planResult.parseAttempts,
        rawInvalidCount: planResult.rawInvalidCount,
      },
      phase: "planning",
      runId,
      sessionId,
      step: stepNumber,
    });
  }
  await appendRunEvent({
    event: "plan_parsed",
    observer,
    payload: {
      action: planResult.action,
      hasToolCall: Boolean(planResult.toolCall),
      parseAttempts: planResult.parseAttempts,
      parseMode: planResult.parseMode,
      rawInvalidCount: planResult.rawInvalidCount,
      transportStructured: planResult.transportStructured,
    },
    phase: "planning",
    runId,
    sessionId,
    step: stepNumber,
  });
}
