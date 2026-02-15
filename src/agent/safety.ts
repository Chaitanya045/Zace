import { z } from "zod";

import type { LlmClient } from "../llm/client";

import { buildCommandSafetyPrompt, COMMAND_SAFETY_SYSTEM_PROMPT } from "../prompts/safety";

const commandSafetyAssessmentSchema = z.object({
  isDestructive: z.boolean(),
  reason: z.string().min(1),
});

export interface CommandSafetyAssessment {
  isDestructive: boolean;
  reason: string;
}

export async function assessCommandSafety(
  client: LlmClient,
  command: string
): Promise<CommandSafetyAssessment> {
  const prompt = buildCommandSafetyPrompt(command);
  const response = await client.chat({
    messages: [
      { content: COMMAND_SAFETY_SYSTEM_PROMPT, role: "system" as const },
      { content: prompt, role: "user" as const },
    ],
  });

  const content = response.content.trim();
  const jsonMatch = content.match(/\{[\s\S]*\}/u);
  if (!jsonMatch) {
    return {
      isDestructive: true,
      reason: "Unable to parse safety assessment response",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const validated = commandSafetyAssessmentSchema.parse(parsed);
    return validated;
  } catch {
    return {
      isDestructive: true,
      reason: "Invalid safety assessment response format",
    };
  }
}
