import type { AgentToolCallEvent, AgentToolResultEvent } from "../agent/observer";
import type { TimelineEntryKind, TimelineEntryTone } from "./types";

const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 700;

function trimPreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n...[truncated]`;
}

export interface TimelineEntryDraft {
  body: string;
  kind: TimelineEntryKind;
  title?: string;
  tone?: TimelineEntryTone;
}

export function buildToolCallTimelineEntry(event: AgentToolCallEvent): TimelineEntryDraft {
  const argumentsText = JSON.stringify(event.arguments, null, 2);
  return {
    body:
      `Step ${String(event.step)} attempt ${String(event.attempt)}\n` +
      `Tool: ${event.name}\n` +
      `${trimPreview(argumentsText, MAX_TOOL_OUTPUT_PREVIEW_CHARS)}`,
    kind: "tool",
    title: "Tool call",
    tone: "accent",
  };
}

export function buildToolResultTimelineEntry(event: AgentToolResultEvent): TimelineEntryDraft {
  const tone: TimelineEntryTone = event.success ? "success" : "danger";
  const status = event.success ? "success" : "failure";
  const preview = trimPreview(event.output, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
  return {
    body:
      `Step ${String(event.step)} attempt ${String(event.attempt)}\n` +
      `Result: ${status}\n` +
      `${event.error ? `Error: ${event.error}\n` : ""}` +
      preview,
    kind: "tool",
    title: "Tool result",
    tone,
  };
}
