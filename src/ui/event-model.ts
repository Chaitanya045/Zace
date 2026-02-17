import type { AgentToolCallEvent, AgentToolResultEvent } from "../agent/observer";
import type { TimelineEntryKind, TimelineEntryTone } from "./types";

const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 700;
const MAX_TAIL_SECTION_CHARS = 260;

function trimPreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n...[truncated]`;
}

function extractTailSection(content: string, sectionHeader: string): string | undefined {
  const sectionIndex = content.indexOf(sectionHeader);
  if (sectionIndex < 0) {
    return undefined;
  }

  return content.slice(sectionIndex).trim();
}

function trimToolResultPreview(content: string, maxChars: number): string {
  const basePreview = trimPreview(content, maxChars);
  if (content.length <= maxChars || basePreview.includes("[lsp]")) {
    return basePreview;
  }

  const lspTail = extractTailSection(content, "[lsp]");
  if (!lspTail) {
    return basePreview;
  }

  const tailPreview = lspTail.length > MAX_TAIL_SECTION_CHARS
    ? `${lspTail.slice(0, MAX_TAIL_SECTION_CHARS)}\n...[truncated]`
    : lspTail;

  const remainingHeadChars = Math.max(120, maxChars - tailPreview.length - 20);
  const headPreview = content.slice(0, remainingHeadChars).trimEnd();
  return `${headPreview}\n...[truncated]\n${tailPreview}`;
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
  const preview = trimToolResultPreview(event.output, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
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
