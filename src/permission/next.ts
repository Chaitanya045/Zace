import { z } from "zod";

import { wildcardMatch } from "../utils/wildcard";

export namespace PermissionNext {
  export const actionSchema = z.enum(["allow", "ask", "deny"]);
  export type Action = z.infer<typeof actionSchema>;

  export const ruleSchema = z.object({
    action: actionSchema,
    pattern: z.string().min(1),
    permission: z.string().min(1),
  });
  export type Rule = z.infer<typeof ruleSchema>;

  export const rulesetSchema = z.array(ruleSchema);
  export type Ruleset = z.infer<typeof rulesetSchema>;

  export const replySchema = z.enum(["always", "once", "reject"]);
  export type Reply = z.infer<typeof replySchema>;

  export const requestSchema = z.object({
    always: z.array(z.string().min(1)),
    id: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
    patterns: z.array(z.string().min(1)),
    permission: z.string().min(1),
    sessionId: z.string().min(1),
    tool: z
      .object({
        callId: z.string().min(1),
        messageId: z.string().min(1),
      })
      .optional(),
  });
  export type Request = z.infer<typeof requestSchema>;

  export class RejectedError extends Error {
    constructor() {
      super("The user rejected permission to use this specific tool call.");
      this.name = "PermissionRejectedError";
    }
  }

  export class AskedError extends Error {
    public readonly prompt: string;

    constructor(prompt: string) {
      super("Permission required. Waiting for user reply.");
      this.name = "PermissionAskedError";
      this.prompt = prompt;
    }
  }

  export class CorrectedError extends Error {
    public readonly userMessage?: string;

    constructor(message: string) {
      super(
        `The user rejected permission to use this specific tool call with the following feedback: ${message}`
      );
      this.name = "PermissionCorrectedError";
      this.userMessage = message;
    }
  }

  export class DeniedError extends Error {
    public readonly ruleset: Ruleset;

    constructor(ruleset: Ruleset) {
      super(
        `A configured permission rule prevents this tool call. Relevant rules: ${JSON.stringify(ruleset)}`
      );
      this.name = "PermissionDeniedError";
      this.ruleset = ruleset;
    }
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat();
  }

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const merged = merge(...rulesets);
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const candidate = merged[index];
      if (!candidate) {
        continue;
      }
      if (!wildcardMatch({ pattern: candidate.permission, value: permission })) {
        continue;
      }
      if (!wildcardMatch({ pattern: candidate.pattern, value: pattern })) {
        continue;
      }
      return candidate;
    }

    return {
      action: "ask",
      pattern: "*",
      permission,
    };
  }

  const EDIT_TOOLS = new Set(["edit", "multiedit", "patch", "write"]);

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>();
    for (const tool of tools) {
      const permission = EDIT_TOOLS.has(tool) ? "edit" : tool;
      const rule = evaluate(permission, "*", ruleset);
      if (rule.action === "deny" && rule.pattern === "*") {
        result.add(tool);
      }
    }
    return result;
  }
}
