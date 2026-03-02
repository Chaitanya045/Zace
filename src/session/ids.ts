import { randomUUID } from "node:crypto";

function withPrefix(prefix: string, id: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return id;
  }
  return `${trimmed}_${id}`;
}

export function newMessageId(): string {
  return withPrefix("msg", randomUUID());
}

export function newPartId(): string {
  return withPrefix("part", randomUUID());
}

export function newStepId(): string {
  return withPrefix("step", randomUUID());
}

export function newToolCallId(): string {
  return withPrefix("tool", randomUUID());
}
