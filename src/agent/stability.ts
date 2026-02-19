import type { AgentStep } from "../types/agent";

import { stableStringify } from "../utils/stable-json";

const PROGRESS_SIGNALS = new Set([
  "files_changed",
]);

export function buildToolCallSignature(
  toolName: string,
  argumentsObject: Record<string, unknown>
): string {
  return `${toolName}|${stableStringify(argumentsObject)}`;
}

export function detectPreExecutionDoomLoop(input: {
  historySignatures: string[];
  nextSignature: string;
  threshold: number;
}): {
  repeatedCount: number;
  shouldBlock: boolean;
} {
  const normalizedThreshold = Math.max(2, Math.trunc(input.threshold));
  let trailingMatches = 0;

  for (let index = input.historySignatures.length - 1; index >= 0; index -= 1) {
    if (input.historySignatures[index] !== input.nextSignature) {
      break;
    }
    trailingMatches += 1;
  }

  const repeatedCount = trailingMatches + 1;
  return {
    repeatedCount,
    shouldBlock: repeatedCount >= normalizedThreshold,
  };
}

export function detectStagnation(input: {
  steps: AgentStep[];
  window: number;
}): {
  isStagnant: boolean;
  reason?: string;
  signals: string[];
  stepsEvaluated: number;
} {
  const normalizedWindow = Math.max(1, Math.trunc(input.window));
  const recentToolSteps = input.steps
    .filter((step) => step.toolCall && step.toolResult)
    .slice(-normalizedWindow);

  if (recentToolSteps.length < normalizedWindow) {
    return {
      isStagnant: false,
      signals: [],
      stepsEvaluated: recentToolSteps.length,
    };
  }

  const signals = recentToolSteps.map((step) => {
    const signal = step.toolResult?.artifacts?.progressSignal;
    return typeof signal === "string" ? signal : "none";
  });
  if (signals.some((signal) => PROGRESS_SIGNALS.has(signal))) {
    return {
      isStagnant: false,
      signals,
      stepsEvaluated: recentToolSteps.length,
    };
  }

  if (recentToolSteps.every((step) => !step.toolResult?.success)) {
    return {
      isStagnant: true,
      reason: "recent tool calls failed without observable progress",
      signals,
      stepsEvaluated: recentToolSteps.length,
    };
  }

  if (
    recentToolSteps.every(
      (step) =>
        step.toolResult?.success &&
        (step.toolResult.artifacts?.progressSignal === "none" ||
          step.toolResult.artifacts?.progressSignal === "success_without_changes" ||
          !step.toolResult.artifacts?.progressSignal)
    )
  ) {
    return {
      isStagnant: true,
      reason: "recent tool calls succeeded but did not produce observable progress",
      signals,
      stepsEvaluated: recentToolSteps.length,
    };
  }

  return {
    isStagnant: false,
    signals,
    stepsEvaluated: recentToolSteps.length,
  };
}
