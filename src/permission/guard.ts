import type { AgentConfig } from "../types/config";
import type { PermissionMemory } from "./memory";

import { PermissionNext } from "./next";
import { createPendingPermissionAction } from "./pending";

export function buildPermissionPrompt(request: {
  always: string[];
  patterns: string[];
  permission: string;
}): string {
  const patternsBlock = request.patterns.length > 0 ? request.patterns.join("\n") : "(none)";
  const alwaysBlock = request.always.length > 0 ? request.always.join("\n") : "(none)";
  return [
    `Permission required: ${request.permission}`,
    "Patterns:",
    patternsBlock,
    "",
    "If you choose 'always', the following patterns will be saved as allow rules:",
    alwaysBlock,
    "",
    "Reply with one of:",
    "- once",
    "- always",
    "- reject",
  ].join("\n");
}

export async function requirePermission(input: {
  config: AgentConfig;
  memory: PermissionMemory;
  metadata?: Record<string, unknown>;
  patterns: string[];
  permission: string;
  runId: string;
  sessionId?: string;
  tool?: {
    callId: string;
    messageId: string;
  };
}): Promise<void> {
  const ruleset = input.memory.ruleset();

  for (const pattern of input.patterns) {
    if (input.memory.consumeOnce(input.permission, pattern)) {
      continue;
    }

    const decision = PermissionNext.evaluate(input.permission, pattern, ruleset);
    if (decision.action === "allow") {
      continue;
    }

    if (decision.action === "deny") {
      const relevant = ruleset.filter((rule) => rule.permission === input.permission);
      throw new PermissionNext.DeniedError(relevant);
    }

    if (!input.sessionId) {
      // Non-interactive session: default to deny-by-ask (block) to be safe.
      throw new PermissionNext.RejectedError();
    }

    if (!input.config.approvalMemoryEnabled) {
      throw new PermissionNext.RejectedError();
    }

    const always = [pattern];
    const prompt = buildPermissionPrompt({
      always,
      patterns: input.patterns,
      permission: input.permission,
    });

    await createPendingPermissionAction({
      always,
      metadata: input.metadata,
      patterns: input.patterns,
      permission: input.permission,
      prompt,
      runId: input.runId,
      sessionId: input.sessionId,
      tool: input.tool,
    });

    // Asking means we must stop and wait for user.
    throw new PermissionNext.RejectedError();
  }
}
