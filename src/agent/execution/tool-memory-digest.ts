import type { ToolResult } from "../../types/tool";

const STREAM_PREVIEW_CHAR_LIMIT = 200;
const STREAM_PREVIEW_LINE_LIMIT = 6;

function extractStructuredSection(output: string, sectionName: string): string | undefined {
  const escapedSectionName = sectionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = output.match(new RegExp(`\\[${escapedSectionName}\\][\\s\\S]*?(?=\\n\\n\\[[^\\n]+\\]|$)`, "u"));
  const section = match?.[0]?.trim();
  return section && section.length > 0 ? section : undefined;
}

function compactExecutionSection(executionSection: string): string {
  const filteredLines = executionSection
    .split("\n")
    .filter((line) => !line.trim().startsWith("command:"));
  return filteredLines.join("\n");
}

function buildStreamPreview(section: string, sectionName: "stderr" | "stdout"): string | undefined {
  const rawBody = section
    .replace(new RegExp(`^\\[${sectionName}\\]\\s*`, "u"), "")
    .trim();
  if (!rawBody || rawBody === "(empty)") {
    return undefined;
  }

  const allLines = rawBody.split("\n");
  const selectedLines = allLines.slice(0, STREAM_PREVIEW_LINE_LIMIT);
  let preview = selectedLines.join("\n").trim();
  let truncated = allLines.length > selectedLines.length;

  if (preview.length > STREAM_PREVIEW_CHAR_LIMIT) {
    preview = preview.slice(0, STREAM_PREVIEW_CHAR_LIMIT).trimEnd();
    truncated = true;
  }

  if (truncated) {
    preview = `${preview}\n...[truncated]`;
  }

  return `[${sectionName}_preview]\n${preview}`;
}

export function buildToolMemoryDigest(input: {
  attempt: number;
  toolName: string;
  toolResult: ToolResult;
}): string {
  const lines = [
    `Tool ${input.toolName} attempt ${String(input.attempt)} result: ${input.toolResult.success ? "success" : "failure"}`,
  ];

  const lspSection = extractStructuredSection(input.toolResult.output, "lsp");
  if (lspSection) {
    lines.push(lspSection);
  }

  const stdoutPreview = buildStreamPreview(
    extractStructuredSection(input.toolResult.output, "stdout") ?? "",
    "stdout"
  );
  if (stdoutPreview) {
    lines.push(stdoutPreview);
  }

  const stderrPreview = buildStreamPreview(
    extractStructuredSection(input.toolResult.output, "stderr") ?? "",
    "stderr"
  );
  if (stderrPreview) {
    lines.push(stderrPreview);
  }

  const executionSection = extractStructuredSection(input.toolResult.output, "execution");
  if (executionSection) {
    lines.push(compactExecutionSection(executionSection));
  }

  const artifactsSection = extractStructuredSection(input.toolResult.output, "artifacts");
  if (artifactsSection) {
    lines.push(artifactsSection.split("\n").slice(0, 4).join("\n"));
  }

  if (!input.toolResult.success && input.toolResult.error) {
    lines.push(`[failure]\n${input.toolResult.error}`);
  }

  return lines.join("\n\n");
}
