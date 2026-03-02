import { resolve } from "node:path";

import type { SessionPermissionRuleEntry } from "../tools/session";
import type { AgentConfig } from "../types/config";

import { appendSessionPermissionRule, readSessionEntries } from "../tools/session";
import { PermissionNext } from "./next";

export type PermissionRuleScope = "session" | "workspace";

// For now we store workspace rules only in the session JSONL to keep changes minimal.
// This mirrors the existing approval_rule entry behavior and keeps persistence auditable.

export async function readPermissionRulesFromSession(input: {
  sessionId: string;
}): Promise<SessionPermissionRuleEntry[]> {
  const entries = await readSessionEntries(input.sessionId);
  return entries.filter((entry): entry is SessionPermissionRuleEntry => entry.type === "permission_rule");
}

export async function loadPermissionRuleset(input: {
  config: AgentConfig;
  sessionId?: string;
  workspaceRoot?: string;
}): Promise<PermissionNext.Ruleset> {
  if (!input.sessionId) {
    return [];
  }

  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const entries = await readPermissionRulesFromSession({ sessionId: input.sessionId });
  return entries
    .filter((entry) => {
      if (entry.scope === "workspace") {
        return resolve(entry.pattern ? workspaceRoot : workspaceRoot) === workspaceRoot;
      }
      return true;
    })
    .map((entry) => ({
      action: entry.action,
      pattern: entry.pattern,
      permission: entry.permission,
    }));
}

export async function storePermissionRule(input: {
  action: PermissionNext.Action;
  config: AgentConfig;
  pattern: string;
  permission: string;
  scope: PermissionRuleScope;
  sessionId: string;
}): Promise<void> {
  if (!input.config.approvalMemoryEnabled) {
    return;
  }

  await appendSessionPermissionRule(input.sessionId, {
    action: input.action,
    pattern: input.pattern,
    permission: input.permission,
    scope: input.scope,
  });
}
