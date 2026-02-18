import { z } from "zod";

import type { LlmClient } from "../llm/client";
import type { ApprovalResponsePromptInput, CommandSafetyPromptContext } from "../prompts/safety";

import {
  APPROVAL_RESPONSE_SYSTEM_PROMPT,
  buildApprovalResponsePrompt,
  buildCommandSafetyPrompt,
  COMMAND_SAFETY_SYSTEM_PROMPT,
} from "../prompts/safety";

const commandSafetyAssessmentSchema = z.object({
  isDestructive: z.boolean(),
  reason: z.string().min(1),
});

const approvalResponseAssessmentSchema = z.object({
  decision: z.enum([
    "allow_once",
    "allow_always_session",
    "allow_always_workspace",
    "deny",
    "unclear",
  ]),
  reason: z.string().min(1),
});

export interface CommandSafetyAssessment {
  isDestructive: boolean;
  reason: string;
}

export interface ApprovalResponseAssessment {
  decision: "allow_always_session" | "allow_always_workspace" | "allow_once" | "deny" | "unclear";
  reason: string;
}

export async function assessCommandSafety(
  client: LlmClient,
  command: string,
  context?: CommandSafetyPromptContext
): Promise<CommandSafetyAssessment> {
  const prompt = buildCommandSafetyPrompt(command, context);
  const response = await client.chat({
    callKind: "safety",
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

export async function assessApprovalResponse(
  client: LlmClient,
  input: ApprovalResponsePromptInput
): Promise<ApprovalResponseAssessment> {
  const prompt = buildApprovalResponsePrompt(input);
  const response = await client.chat({
    callKind: "safety",
    messages: [
      { content: APPROVAL_RESPONSE_SYSTEM_PROMPT, role: "system" as const },
      { content: prompt, role: "user" as const },
    ],
  });

  const content = response.content.trim();
  const jsonMatch = content.match(/\{[\s\S]*\}/u);
  if (!jsonMatch) {
    return {
      decision: "unclear",
      reason: "Unable to parse approval response",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const validated = approvalResponseAssessmentSchema.parse(parsed);
    return validated;
  } catch {
    return {
      decision: "unclear",
      reason: "Invalid approval response format",
    };
  }
}
