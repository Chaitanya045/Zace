import type { ToolCallLike } from "./types";

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const parsed = Math.trunc(value);
  if (parsed < 0) {
    return undefined;
  }

  return parsed;
}

export function getRetryConfiguration(
  toolCall: ToolCallLike,
  defaults: {
    maxRetries: number;
    retryMaxDelayMs: number;
  }
): {
  maxRetries: number;
  retryMaxDelayMs?: number;
} {
  if (toolCall.name !== "execute_command") {
    return {
      maxRetries: defaults.maxRetries,
      retryMaxDelayMs: defaults.retryMaxDelayMs,
    };
  }

  const requestedMaxRetries = parseNonNegativeInteger(toolCall.arguments.maxRetries);
  const retryMaxDelayMs = parseNonNegativeInteger(toolCall.arguments.retryMaxDelayMs);

  return {
    maxRetries: Math.min(
      requestedMaxRetries === undefined ? defaults.maxRetries : requestedMaxRetries,
      defaults.maxRetries
    ),
    retryMaxDelayMs: Math.min(
      retryMaxDelayMs === undefined ? defaults.retryMaxDelayMs : retryMaxDelayMs,
      defaults.retryMaxDelayMs
    ),
  };
}

export function getRetryDelayMs(
  retryDelayMs: number | undefined,
  retryMaxDelayMs: number | undefined
): number {
  if (typeof retryDelayMs !== "number" || !Number.isFinite(retryDelayMs)) {
    return 0;
  }

  const normalizedDelay = Math.max(0, Math.trunc(retryDelayMs));
  if (retryMaxDelayMs === undefined) {
    return normalizedDelay;
  }

  return Math.min(normalizedDelay, retryMaxDelayMs);
}

export async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
