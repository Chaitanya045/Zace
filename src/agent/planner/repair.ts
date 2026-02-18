export function buildPlannerJsonRepairPrompt(previousResponse: string): string {
  const compactResponse = previousResponse.replace(/\s+/gu, " ").trim();
  const preview = compactResponse.length > 1200
    ? `${compactResponse.slice(0, 1200)}...`
    : compactResponse;
  return [
    "Your previous planner response did not match the required strict JSON schema.",
    "Return strict JSON only, exactly matching the schema from the planner prompt.",
    "Do not include markdown, XML tags, or prose outside JSON.",
    `Previous response preview: ${preview}`,
  ].join("\n");
}

export function buildPlannerJsonRetryPrompt(previousResponse: string): string {
  const compactResponse = previousResponse.replace(/\s+/gu, " ").trim();
  const preview = compactResponse.length > 800
    ? `${compactResponse.slice(0, 800)}...`
    : compactResponse;
  return [
    "Retry the planner response now.",
    "Output must be strict JSON matching the planner schema and nothing else.",
    "Do not include markdown fences, XML tags, or explanatory text.",
    `Last invalid response preview: ${preview}`,
  ].join("\n");
}
