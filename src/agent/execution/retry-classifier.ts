import type { ToolCall, ToolResult } from "../../types/tool";

export type RetryCategory = "non_transient" | "transient" | "unknown";

export type RetryClassification = {
  category: RetryCategory;
  reason: string;
};

const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /\bECONNRESET\b/u,
  /\bEPIPE\b/u,
  /\bETIMEDOUT\b/u,
  /\bEAI_AGAIN\b/u,
  /\bENETUNREACH\b/u,
  /\bEHOSTUNREACH\b/u,
  /\bTLS\b.*\btimeout\b/iu,
  /\bhandshake\b.*\btimeout\b/iu,
  /\btemporar(?:y|ily)\b.*\bfail(?:ed|ure)\b/iu,
];

function normalizeMessage(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function classifyRetry(toolCall: ToolCall, toolResult: ToolResult): RetryClassification {
  if (toolResult.success) {
    return {
      category: "unknown",
      reason: "tool_result_success",
    };
  }

  const lifecycleEvent = toolResult.artifacts?.lifecycleEvent;
  if (lifecycleEvent === "abort" || toolResult.artifacts?.aborted) {
    return {
      category: "non_transient",
      reason: "command_aborted",
    };
  }

  if (lifecycleEvent === "timeout" || toolResult.artifacts?.timedOut) {
    return {
      category: "transient",
      reason: "command_timeout",
    };
  }

  const errorMessage = normalizeMessage(toolResult.error);
  const outputMessage = normalizeMessage(toolResult.output);
  const combined = `${errorMessage}\n${outputMessage}`.trim();

  if (toolCall.name === "execute_command") {
    if (/\btimed out\b/iu.test(combined)) {
      return {
        category: "transient",
        reason: "command_timeout_message",
      };
    }

    if (/\baborted\b/iu.test(combined)) {
      return {
        category: "non_transient",
        reason: "command_aborted_message",
      };
    }

    return {
      category: "non_transient",
      reason: "command_failed_without_transient_signal",
    };
  }

  if (combined && TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(combined))) {
    return {
      category: "transient",
      reason: "transient_infrastructure_error_pattern",
    };
  }

  return {
    category: "unknown",
    reason: "unclassified_failure",
  };
}

