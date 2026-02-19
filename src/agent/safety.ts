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

const DESTRUCTIVE_COMMAND_FALLBACK_RULES: Array<{
  reason: string;
  regex: RegExp;
}> = [
  {
    reason: "fallback: file deletion command",
    regex: /\b(?:rm|rmdir|unlink)\b/u,
  },
  {
    reason: "fallback: force git history rewrite",
    regex: /\bgit\s+reset\s+--hard\b|\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/u,
  },
  {
    reason: "fallback: git clean removes untracked files",
    regex: /\bgit\s+clean\b[^\n]*\s-f\b/u,
  },
  {
    reason: "fallback: recursive permission/ownership mutation",
    regex: /\b(?:chmod|chown|chgrp)\b[^\n]*(?:\s+-R\b|\s+--recursive\b)/u,
  },
  {
    reason: "fallback: high-impact system command",
    regex: /\b(?:mkfs|dd|shutdown|reboot|poweroff)\b/u,
  },
];

function fallbackAssessCommandSafety(
  command: string,
  context?: CommandSafetyPromptContext
): CommandSafetyAssessment {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return {
      isDestructive: false,
      reason: "fallback: empty command",
    };
  }

  const overwriteTargets = context?.overwriteRedirectTargets ?? [];
  const existingOverwriteTarget = overwriteTargets.find((target) => target.exists === "yes");
  if (existingOverwriteTarget) {
    return {
      isDestructive: true,
      reason: `fallback: overwrites existing file via redirect (${existingOverwriteTarget.rawPath})`,
    };
  }

  for (const rule of DESTRUCTIVE_COMMAND_FALLBACK_RULES) {
    if (rule.regex.test(normalizedCommand)) {
      return {
        isDestructive: true,
        reason: rule.reason,
      };
    }
  }

  return {
    isDestructive: false,
    reason: "fallback: no destructive patterns detected",
  };
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
    return fallbackAssessCommandSafety(command, context);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const validated = commandSafetyAssessmentSchema.parse(parsed);
    return validated;
  } catch {
    return fallbackAssessCommandSafety(command, context);
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
