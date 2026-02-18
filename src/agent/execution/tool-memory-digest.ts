import type { ToolResult } from "../../types/tool";

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
