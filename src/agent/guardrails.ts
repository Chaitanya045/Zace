const COMMAND_OUTPUT_LIMIT_FOR_SIGNATURE = 400;

function normalizeOutputForSignature(output: string): string {
  return output
    .replace(/stdout:\s+[^\n]+/giu, "stdout:<artifact>")
    .replace(/stderr:\s+[^\n]+/giu, "stderr:<artifact>")
    .replace(/combined:\s+[^\n]+/giu, "combined:<artifact>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, "<uuid>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, COMMAND_OUTPUT_LIMIT_FOR_SIGNATURE);
}

export function buildToolLoopSignature(input: {
  argumentsObject: Record<string, unknown>;
  output: string;
  success: boolean;
  toolName: string;
}): string {
  const normalizedOutput = normalizeOutputForSignature(input.output);
  return [
    input.toolName,
    JSON.stringify(input.argumentsObject),
    input.success ? "success" : "failure",
    normalizedOutput,
  ].join("|");
}
