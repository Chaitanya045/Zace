import { isAbsolute, relative, resolve } from "node:path";

import type { AgentStep } from "../types/agent";

import { stableStringify } from "../utils/stable-json";

const PROGRESS_SIGNALS = new Set([
  "files_changed",
]);

const WINDOWS_ABSOLUTE_PATH_REGEX = /^[A-Za-z]:[\\/]/u;

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function splitAssignmentToken(value: string): {
  keyPrefix: string;
  tokenValue: string;
} {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0) {
    return {
      keyPrefix: "",
      tokenValue: value,
    };
  }

  return {
    keyPrefix: value.slice(0, separatorIndex + 1),
    tokenValue: value.slice(separatorIndex + 1),
  };
}

function looksLikePathToken(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value === "." || value === "..") {
    return true;
  }
  if (value.startsWith("./") || value.startsWith("../")) {
    return true;
  }
  if (value.includes("/") || value.includes("\\")) {
    return true;
  }
  if (isAbsolute(value) || WINDOWS_ABSOLUTE_PATH_REGEX.test(value)) {
    return true;
  }

  return false;
}

function normalizePathToken(value: string): string {
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/u, "");
  }
  if (!normalized) {
    return ".";
  }

  return normalized;
}

function isWithinDirectory(relativePath: string): boolean {
  return relativePath.length > 0 && !relativePath.startsWith("../") && relativePath !== "..";
}

function canonicalizeCommandToken(token: string, workingDirectory: string): string {
  if (!token) {
    return token;
  }

  const quotePrefix = token.startsWith("\"") ? "\"" : token.startsWith("'") ? "'" : "";
  const quoteSuffix = quotePrefix && token.endsWith(quotePrefix) ? quotePrefix : "";
  const tokenBody = quotePrefix && quoteSuffix ? token.slice(1, -1) : token;
  const { keyPrefix, tokenValue } = splitAssignmentToken(tokenBody);
  const strippedValue = stripWrappingQuotes(tokenValue);

  if (!looksLikePathToken(strippedValue)) {
    return token;
  }

  const normalizedInputPath = normalizePathToken(strippedValue);
  const isAbsolutePath =
    isAbsolute(normalizedInputPath) || WINDOWS_ABSOLUTE_PATH_REGEX.test(normalizedInputPath);
  let normalizedPath = normalizedInputPath;
  if (isAbsolutePath) {
    const resolvedPath = resolve(normalizedInputPath);
    const relativePath = relative(workingDirectory, resolvedPath).replaceAll("\\", "/");
    if (isWithinDirectory(relativePath)) {
      normalizedPath = normalizePathToken(relativePath);
    } else if (relativePath === "") {
      normalizedPath = ".";
    } else {
      normalizedPath = normalizePathToken(resolvedPath);
    }
  }

  const rebuiltToken = `${keyPrefix}${normalizedPath}`;
  if (quotePrefix && quoteSuffix) {
    return `${quotePrefix}${rebuiltToken}${quoteSuffix}`;
  }

  return rebuiltToken;
}

function canonicalizeExecuteCommand(command: string, workingDirectory: string): string {
  const normalizedCommand = normalizeWhitespace(command);
  if (!normalizedCommand) {
    return normalizedCommand;
  }

  return normalizedCommand
    .split(" ")
    .map((token) => canonicalizeCommandToken(token, workingDirectory))
    .join(" ");
}

export function buildToolCallSignature(
  toolName: string,
  argumentsObject: Record<string, unknown>,
  options?: {
    workingDirectory?: string;
  }
): string {
  if (toolName !== "execute_command") {
    return `${toolName}|${stableStringify(argumentsObject)}`;
  }

  const workingDirectoryValue =
    typeof argumentsObject.cwd === "string" && argumentsObject.cwd.trim().length > 0
      ? argumentsObject.cwd
      : options?.workingDirectory ?? process.cwd();
  const resolvedWorkingDirectory = resolve(workingDirectoryValue);
  const signatureArguments: Record<string, unknown> = {
    ...argumentsObject,
    cwd: resolvedWorkingDirectory,
  };
  if (typeof argumentsObject.command === "string") {
    signatureArguments.command = canonicalizeExecuteCommand(
      argumentsObject.command,
      resolvedWorkingDirectory
    );
  }

  return `${toolName}|${stableStringify(signatureArguments)}`;
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
