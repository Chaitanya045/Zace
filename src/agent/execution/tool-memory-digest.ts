import type { ToolResult } from "../../types/tool";

const STREAM_PREVIEW_BYTE_LIMIT = 2048;
const STREAM_PREVIEW_LINE_LIMIT = 64;
const STREAM_PREVIEW_MAX_CHARS_PER_LINE = 220;
const STREAM_PREVIEW_TRUNCATION_NOTICE =
  "...[truncated: output preview is capped at 2048 bytes, 64 lines, 220 chars per line]";

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

function truncateToByteLength(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let truncated = "";
  let usedBytes = 0;
  for (const character of value) {
    const nextCharacterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + nextCharacterBytes > maxBytes) {
      break;
    }

    truncated += character;
    usedBytes += nextCharacterBytes;
  }

  return truncated;
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
  let truncated = allLines.length > selectedLines.length;

  const lineBoundedLines = selectedLines.map((line) => {
    if (line.length <= STREAM_PREVIEW_MAX_CHARS_PER_LINE) {
      return line;
    }
    truncated = true;
    return `${line.slice(0, STREAM_PREVIEW_MAX_CHARS_PER_LINE).trimEnd()}...[line_truncated]`;
  });

  let preview = "";
  for (const [index, line] of lineBoundedLines.entries()) {
    const segment = index === 0 ? line : `\n${line}`;
    const candidate = `${preview}${segment}`;
    if (Buffer.byteLength(candidate, "utf8") <= STREAM_PREVIEW_BYTE_LIMIT) {
      preview = candidate;
      continue;
    }

    const remainingBytes = STREAM_PREVIEW_BYTE_LIMIT - Buffer.byteLength(preview, "utf8");
    preview = `${preview}${truncateToByteLength(segment, remainingBytes)}`;
    truncated = true;
    break;
  }
  preview = preview.trim();

  if (truncated) {
    preview = `${preview}\n${STREAM_PREVIEW_TRUNCATION_NOTICE}`;
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
