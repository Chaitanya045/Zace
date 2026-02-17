import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import type { LlmClient } from "../llm/client";
import type { SessionPendingActionEntry } from "../tools/session";
import type { AgentConfig } from "../types/config";

import {
  appendSessionApprovalRule,
  appendSessionPendingAction,
  findLatestOpenPendingAction,
  readSessionEntries,
} from "../tools/session";
import { buildExecuteCommandSignature } from "../tools/shell";
import { assessApprovalResponse } from "./safety";

export type ApprovalDecision = "allow" | "deny";
export type ApprovalRuleScope = "session" | "workspace";
export type ApprovalResolutionScope = "once" | ApprovalRuleScope;

const pendingApprovalContextSchema = z.object({
  command: z.string().min(1),
  commandSignature: z.string().min(1),
  pendingId: z.string().min(1),
  reason: z.string().min(1),
  workingDirectory: z.string().min(1).optional(),
});

type PendingApprovalContext = z.infer<typeof pendingApprovalContextSchema>;

const storedApprovalRuleSchema = z.object({
  createdAt: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
  pattern: z.string().min(1),
  scope: z.enum(["session", "workspace"]),
  sessionId: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1),
});

type StoredApprovalRule = z.infer<typeof storedApprovalRuleSchema>;

const storedApprovalRulesFileSchema = z.object({
  rules: z.array(storedApprovalRuleSchema),
});

export type ApprovalRuleDecisionResult = {
  decision: ApprovalDecision;
  pattern: string;
  scope: ApprovalRuleScope;
};

export type OpenPendingApproval = {
  context: PendingApprovalContext;
  entry: SessionPendingActionEntry;
};

export type ApprovalReplyDecision =
  | "allow_always_session"
  | "allow_always_workspace"
  | "allow_once"
  | "deny"
  | "unclear";

export type ApprovalReplyResolution =
  | {
      commandSignature?: string;
      contextNote: string;
      decision: "allow" | "deny";
      message: string;
      scope: ApprovalResolutionScope;
      status: "resolved";
    }
  | {
      message: string;
      status: "unclear";
    };

function resolveRulesFilePath(config: AgentConfig): string {
  return resolve(config.approvalRulesPath);
}

function parseRegexPattern(pattern: string): null | RegExp {
  if (!pattern.startsWith("/")) {
    return null;
  }
  const lastSlashIndex = pattern.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return null;
  }

  const source = pattern.slice(1, lastSlashIndex);
  const flags = pattern.slice(lastSlashIndex + 1);
  if (!source) {
    return null;
  }

  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export function matchesApprovalRulePattern(pattern: string, commandSignature: string): boolean {
  const trimmedPattern = pattern.trim();
  if (!trimmedPattern) {
    return false;
  }

  if (trimmedPattern === commandSignature) {
    return true;
  }

  const regex = parseRegexPattern(trimmedPattern);
  if (!regex) {
    return false;
  }

  return regex.test(commandSignature);
}

async function readStoredApprovalRules(config: AgentConfig): Promise<StoredApprovalRule[]> {
  const path = resolveRulesFilePath(config);
  let fileContent: string;
  try {
    fileContent = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(
      `Invalid JSON in approval rules file (${path}): ${error instanceof Error ? error.message : "Unknown parse error"}`
    );
  }

  const validated = storedApprovalRulesFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid approval rules file (${path}): ${validated.error.message}`);
  }

  return validated.data.rules;
}

async function writeStoredApprovalRules(
  config: AgentConfig,
  rules: StoredApprovalRule[]
): Promise<void> {
  const path = resolveRulesFilePath(config);
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify({ rules }, null, 2);
  await writeFile(path, `${payload}\n`, "utf8");
}

export function buildApprovalCommandSignature(
  command: string,
  workingDirectory?: string
): string {
  return buildExecuteCommandSignature(command, workingDirectory ?? process.cwd());
}

export async function findApprovalRuleDecision(input: {
  commandSignature: string;
  config: AgentConfig;
  sessionId?: string;
  workspaceRoot?: string;
}): Promise<ApprovalRuleDecisionResult | null> {
  if (!input.config.approvalMemoryEnabled) {
    return null;
  }

  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const rules = await readStoredApprovalRules(input.config);
  const matchingRules = rules.filter((rule) => {
    if (!matchesApprovalRulePattern(rule.pattern, input.commandSignature)) {
      return false;
    }

    if (rule.scope === "workspace") {
      return resolve(rule.workspaceRoot) === workspaceRoot;
    }

    if (!input.sessionId) {
      return false;
    }

    return rule.sessionId === input.sessionId;
  });
  if (matchingRules.length === 0) {
    return null;
  }

  matchingRules.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const matchedRule = matchingRules[matchingRules.length - 1];
  if (!matchedRule) {
    return null;
  }
  return {
    decision: matchedRule.decision,
    pattern: matchedRule.pattern,
    scope: matchedRule.scope,
  };
}

export async function storeApprovalRule(input: {
  commandSignaturePattern: string;
  config: AgentConfig;
  decision: ApprovalDecision;
  scope: ApprovalRuleScope;
  sessionId?: string;
  workspaceRoot?: string;
}): Promise<void> {
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const createdAt = new Date().toISOString();
  const rules = await readStoredApprovalRules(input.config);
  const updatedRules = rules.filter((rule) => {
    if (rule.pattern !== input.commandSignaturePattern || rule.scope !== input.scope) {
      return true;
    }
    if (rule.scope === "workspace") {
      return resolve(rule.workspaceRoot) !== workspaceRoot;
    }
    return rule.sessionId !== input.sessionId;
  });

  const nextRule: StoredApprovalRule = {
    createdAt,
    decision: input.decision,
    pattern: input.commandSignaturePattern,
    scope: input.scope,
    workspaceRoot,
  };
  if (input.scope === "session" && input.sessionId) {
    nextRule.sessionId = input.sessionId;
  }
  updatedRules.push(nextRule);
  await writeStoredApprovalRules(input.config, updatedRules);
}

export async function createPendingApprovalAction(input: {
  command: string;
  commandSignature: string;
  prompt: string;
  reason: string;
  runId: string;
  sessionId: string;
  workingDirectory?: string;
}): Promise<string> {
  const pendingId = randomUUID();
  await appendSessionPendingAction(input.sessionId, {
    context: {
      command: input.command,
      commandSignature: input.commandSignature,
      pendingId,
      reason: input.reason,
      workingDirectory: input.workingDirectory,
    },
    kind: "approval",
    prompt: input.prompt,
    runId: input.runId,
    sessionId: input.sessionId,
    status: "open",
  });
  return pendingId;
}

export async function resolvePendingApprovalAction(input: {
  entry: SessionPendingActionEntry;
  sessionId: string;
  updates?: Record<string, unknown>;
}): Promise<void> {
  await appendSessionPendingAction(input.sessionId, {
    context: {
      ...input.entry.context,
      ...(input.updates ?? {}),
    },
    kind: input.entry.kind,
    prompt: input.entry.prompt,
    runId: input.entry.runId,
    sessionId: input.entry.sessionId,
    status: "resolved",
  });
}

function parsePendingApprovalContext(entry: SessionPendingActionEntry): null | PendingApprovalContext {
  const parsed = pendingApprovalContextSchema.safeParse(entry.context);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export async function findOpenPendingApproval(input: {
  maxAgeMs: number;
  sessionId: string;
}): Promise<null | OpenPendingApproval> {
  const entries = await readSessionEntries(input.sessionId);
  const pending = findLatestOpenPendingAction(entries, "approval");
  if (!pending) {
    return null;
  }

  const context = parsePendingApprovalContext(pending);
  if (!context) {
    return null;
  }

  const createdAt = Date.parse(pending.timestamp);
  const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : Number.POSITIVE_INFINITY;
  if (ageMs > input.maxAgeMs) {
    return null;
  }

  return {
    context,
    entry: pending,
  };
}

export function buildPendingApprovalPrompt(input: {
  command: string;
  reason: string;
  riskyConfirmationToken: string;
}): string {
  return (
    `Destructive command requires confirmation: ${input.reason}\n` +
    `Command: ${input.command}\n` +
    "Reply with one of the following:\n" +
    "- allow once\n" +
    "- always allow for this session\n" +
    "- always allow for this workspace\n" +
    "- deny\n" +
    `Legacy fallback: reply with "${input.riskyConfirmationToken}" to allow once.`
  );
}

export async function resolveApprovalFromUserReply(input: {
  client: LlmClient;
  config: AgentConfig;
  pendingApproval: OpenPendingApproval;
  sessionId: string;
  userMessage: string;
}): Promise<ApprovalReplyResolution> {
  const trimmedUserMessage = input.userMessage.trim();
  const legacyTokenDecision =
    trimmedUserMessage.includes(input.config.riskyConfirmationToken) ? "allow_once" : null;
  const decision: ApprovalReplyDecision =
    legacyTokenDecision ??
    (await assessApprovalResponse(input.client, {
      approvalPrompt: input.pendingApproval.entry.prompt,
      command: input.pendingApproval.context.command,
      reason: input.pendingApproval.context.reason,
      userReply: input.userMessage,
    })).decision;

  if (decision === "unclear") {
    return {
      message:
        "I could not determine the approval decision. Reply with: allow once, always allow for this session/workspace, or deny.",
      status: "unclear",
    };
  }

  if (decision === "allow_once") {
    await resolvePendingApprovalAction({
      entry: input.pendingApproval.entry,
      sessionId: input.sessionId,
      updates: {
        decision: "allow",
        scope: "once",
      },
    });
    return {
      commandSignature: input.pendingApproval.context.commandSignature,
      contextNote:
        `Approval resolved by user: allow once.\n` +
        `Approved command: ${input.pendingApproval.context.command}\n` +
        `Reason: ${input.pendingApproval.context.reason}`,
      decision: "allow",
      message: "Approval resolved: allow once.",
      scope: "once",
      status: "resolved",
    };
  }

  if (decision === "deny") {
    await resolvePendingApprovalAction({
      entry: input.pendingApproval.entry,
      sessionId: input.sessionId,
      updates: {
        decision: "deny",
        scope: "once",
      },
    });
    return {
      contextNote:
        `Approval resolved by user: deny.\n` +
        `Denied command: ${input.pendingApproval.context.command}\n` +
        `Reason: ${input.pendingApproval.context.reason}`,
      decision: "deny",
      message: "Approval resolved: deny. I will not execute the pending destructive command.",
      scope: "once",
      status: "resolved",
    };
  }

  const scope: ApprovalRuleScope =
    decision === "allow_always_workspace" ? "workspace" : "session";
  await storeApprovalRule({
    commandSignaturePattern: input.pendingApproval.context.commandSignature,
    config: input.config,
    decision: "allow",
    scope,
    sessionId: input.sessionId,
  });
  await appendSessionApprovalRule(input.sessionId, {
    decision: "allow",
    pattern: input.pendingApproval.context.commandSignature,
    scope,
  });
  await resolvePendingApprovalAction({
    entry: input.pendingApproval.entry,
    sessionId: input.sessionId,
    updates: {
      decision: "allow",
      scope,
    },
  });
  return {
    contextNote:
      `Approval resolved by user: always allow (${scope}).\n` +
      `Command signature: ${input.pendingApproval.context.commandSignature}`,
    decision: "allow",
    message: `Approval resolved: always allow for this ${scope}.`,
    scope,
    status: "resolved",
  };
}
