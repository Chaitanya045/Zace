import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { LlmClient } from "../../../llm/client";
import type { AgentConfig } from "../../../types/config";

import { assessCommandSafety } from "../../safety";
import { SCRIPT_DIRECTORY_PATH } from "../../scripts";

const OVERWRITE_REDIRECT_TARGET_REGEX = /(?:^|[\s;|&])(?:\d*)>(?!>|&)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/gu;
const GIT_READONLY_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "realpath",
  "rg",
  "stat",
  "tail",
  "tree",
  "wc",
]);
const RUNTIME_SCRIPT_MARKER_REGEX = /\bZACE_SCRIPT_(?:REGISTER|USE)\|/u;
const RUNTIME_SCRIPT_PROTOCOL_BYPASS_REGEX = /(?:^|[\s"'=])\.zace\/runtime\/scripts(?:[/\s"'=]|$)/u;
const SH_RUNTIME_SCRIPT_INVOCATION_REGEX = /^sh\s+((?:"[^"]+"|'[^']+'|\S+))(.*)$/u;
const SHELL_REDIRECTION_REGEX = /(?:^|[\s;|&])(?:\d*)>(?!>|&)|>>|<<|(?:^|[\s;|&])</u;
const MUTATING_COMMAND_REGEX =
  /\b(?:bun\s+add|chmod|chown|cp|git\s+(?:add|checkout|clean|commit|mv|reset|rm)|mkdir|mv|npm\s+(?:install|uninstall)|perl\s+-i|pnpm\s+(?:add|install|remove)|rm|sed\s+-i|touch|truncate|yarn\s+(?:add|install|remove))\b/iu;
const HIGH_RISK_DESTRUCTIVE_COMMAND_REGEX =
  /\b(?:rm\b|rmdir\b|unlink\b|git\s+reset\s+--hard\b|git\s+clean\b[^\n]*\s-f\b|git\s+push\b[^\n]*\s--force(?:-with-lease)?\b|mkfs\b|dd\b|shutdown\b|reboot\b|poweroff\b)\b/iu;
const RUNTIME_MAINTENANCE_ALLOWED_FILES = new Set([".zace/runtime/lsp/servers.json"]);
const VALIDATION_COMMAND_PATTERNS = [
  /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:build|check|lint|test|typecheck)\b/iu,
  /^(?:cargo\s+(?:check|clippy|test)|eslint|go\s+test|jest|pytest|ruff|tsc|vitest)\b/iu,
];

export function getExecuteCommandText(argumentsObject: Record<string, unknown>): string | undefined {
  const commandValue = argumentsObject.command;
  if (typeof commandValue !== "string") {
    return undefined;
  }

  const command = commandValue.trim();
  if (!command) {
    return undefined;
  }

  return command;
}

export function getExecuteCommandWorkingDirectory(
  argumentsObject: Record<string, unknown>
): string | undefined {
  const cwdValue = argumentsObject.cwd;
  if (typeof cwdValue !== "string") {
    return undefined;
  }

  const cwd = cwdValue.trim();
  if (!cwd) {
    return undefined;
  }

  return cwd;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isPathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

function extractCommandSegments(command: string): string[] {
  return command
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function parseRootCommand(segment: string): {
  firstToken: string;
  secondToken: string;
} {
  const normalized = normalizeWhitespace(segment);
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  const firstToken = tokens[0]?.toLowerCase() ?? "";
  const secondToken = tokens[1]?.toLowerCase() ?? "";

  return {
    firstToken,
    secondToken,
  };
}

function isValidationCommand(command: string): boolean {
  const normalized = normalizeWhitespace(command);
  if (!normalized) {
    return false;
  }
  if (/[\r\n]|&&|\|\||;/u.test(normalized)) {
    return false;
  }

  return VALIDATION_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeTokenForPathCandidate(token: string): string {
  const unquoted = stripWrappingQuotes(token.trim())
    .replace(/^[();]+/u, "")
    .replace(/[();]+$/u, "");
  const assignmentSeparatorIndex = unquoted.indexOf("=");
  if (assignmentSeparatorIndex <= 0) {
    return unquoted;
  }

  return unquoted.slice(assignmentSeparatorIndex + 1);
}

function resolveRuntimeMaintenanceAllowedRoots(workingDirectory: string): string[] {
  const roots = [resolve(workingDirectory, SCRIPT_DIRECTORY_PATH)];
  for (const relativePath of RUNTIME_MAINTENANCE_ALLOWED_FILES) {
    roots.push(resolve(workingDirectory, relativePath));
  }
  return roots;
}

function isWithinAnyRoot(pathValue: string, roots: string[]): boolean {
  return roots.some((root) => isPathWithinRoot(pathValue, root));
}

function isRuntimeMaintenanceRedirectWrite(command: string, workingDirectory: string): boolean {
  const targets = extractOverwriteRedirectTargets(command);
  if (targets.length === 0) {
    return false;
  }

  const roots = resolveRuntimeMaintenanceAllowedRoots(workingDirectory);
  return targets.every((target) => {
    if (!target) {
      return false;
    }

    const normalized = stripWrappingQuotes(target.trim());
    if (!normalized || normalized.startsWith("~") || isDynamicShellPath(normalized)) {
      return false;
    }

    const resolvedTarget = resolve(workingDirectory, normalized);
    return isWithinAnyRoot(resolvedTarget, roots);
  });
}

function isHighRiskDestructiveCommand(command: string): boolean {
  return HIGH_RISK_DESTRUCTIVE_COMMAND_REGEX.test(command);
}

export function normalizeRuntimeScriptInvocation(input: {
  command: string;
  workingDirectory: string;
}): {
  changed: boolean;
  command: string;
  reason?: string;
} {
  const normalized = normalizeWhitespace(input.command);
  if (!normalized) {
    return {
      changed: false,
      command: normalized,
    };
  }

  const match = normalized.match(SH_RUNTIME_SCRIPT_INVOCATION_REGEX);
  if (!match) {
    return {
      changed: false,
      command: normalized,
    };
  }

  const scriptToken = match[1];
  if (!scriptToken) {
    return {
      changed: false,
      command: normalized,
    };
  }
  const remaining = match[2] ?? "";
  const scriptPath = stripWrappingQuotes(scriptToken);
  if (!scriptPath || extname(scriptPath).toLowerCase() !== ".sh") {
    return {
      changed: false,
      command: normalized,
    };
  }

  const scriptDirectoryAbsolutePath = resolve(input.workingDirectory, SCRIPT_DIRECTORY_PATH);
  const resolvedScriptPath = resolve(input.workingDirectory, scriptPath);
  if (!isPathWithinRoot(resolvedScriptPath, scriptDirectoryAbsolutePath)) {
    return {
      changed: false,
      command: normalized,
    };
  }

  return {
    changed: true,
    command: `bash ${scriptToken}${remaining}`.trim(),
    reason: "runtime_script_shell_normalization",
  };
}

export function isRuntimeScriptInvocation(command: string, workingDirectory: string): boolean {
  const normalized = normalizeWhitespace(command);
  if (!normalized) {
    return false;
  }

  const scriptDirectoryAbsolutePath = resolve(workingDirectory, SCRIPT_DIRECTORY_PATH);
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  for (const token of tokens) {
    const pathCandidate = normalizeTokenForPathCandidate(token);
    if (!pathCandidate || pathCandidate.startsWith("-")) {
      continue;
    }
    if (/[*?${}`]/u.test(pathCandidate)) {
      continue;
    }

    const resolvedCandidate = resolve(workingDirectory, pathCandidate);
    if (isPathWithinRoot(resolvedCandidate, scriptDirectoryAbsolutePath)) {
      return true;
    }
  }

  return false;
}

export function isReadOnlyInspectionCommand(command: string): boolean {
  const normalized = normalizeWhitespace(command);
  if (!normalized) {
    return false;
  }
  if (/[\r\n]|&&|\|\||;/u.test(normalized)) {
    return false;
  }
  if (SHELL_REDIRECTION_REGEX.test(normalized)) {
    return false;
  }

  const segments = extractCommandSegments(normalized);
  if (segments.length === 0) {
    return false;
  }

  return segments.every((segment) => {
    const { firstToken, secondToken } = parseRootCommand(segment);
    if (!firstToken) {
      return false;
    }
    if (firstToken === "git") {
      return GIT_READONLY_SUBCOMMANDS.has(secondToken);
    }

    return READ_ONLY_COMMANDS.has(firstToken);
  });
}

export function requiresRuntimeScript(command: string): boolean {
  const normalized = normalizeWhitespace(command);
  if (!normalized) {
    return false;
  }
  if (isReadOnlyInspectionCommand(normalized) || isValidationCommand(normalized)) {
    return false;
  }
  if (RUNTIME_SCRIPT_PROTOCOL_BYPASS_REGEX.test(normalized)) {
    return false;
  }
  if (RUNTIME_SCRIPT_MARKER_REGEX.test(normalized)) {
    return false;
  }
  if (MUTATING_COMMAND_REGEX.test(normalized)) {
    return true;
  }
  if (SHELL_REDIRECTION_REGEX.test(normalized)) {
    return true;
  }
  if (/[\r\n]|&&|\|\||;|<<|>>/u.test(normalized)) {
    return true;
  }

  return false;
}

export function extractOverwriteRedirectTargets(command: string): string[] {
  const targets = new Set<string>();
  for (const match of command.matchAll(OVERWRITE_REDIRECT_TARGET_REGEX)) {
    const rawTarget = match[1];
    if (!rawTarget) {
      continue;
    }

    const normalized = stripWrappingQuotes(rawTarget.trim());
    if (!normalized) {
      continue;
    }

    targets.add(normalized);
  }

  return Array.from(targets).sort((left, right) => left.localeCompare(right));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isDynamicShellPath(value: string): boolean {
  return /[`$*?{}()]/u.test(value);
}

async function buildCommandSafetyContext(
  command: string,
  workingDirectory: string
): Promise<{
  overwriteRedirectTargets: Array<{
    exists: "no" | "unknown" | "yes";
    rawPath: string;
    resolvedPath: string;
  }>;
  workingDirectory: string;
}> {
  const targets = extractOverwriteRedirectTargets(command);
  const overwriteRedirectTargets = await Promise.all(
    targets.slice(0, 12).map(async (target) => {
      if (
        !target ||
        target === "-" ||
        target === "/dev/null" ||
        target.toLowerCase() === "nul" ||
        target.startsWith("~") ||
        isDynamicShellPath(target)
      ) {
        return {
          exists: "unknown" as const,
          rawPath: target,
          resolvedPath: target || "<empty>",
        };
      }

      const resolvedPath = resolve(workingDirectory, target);
      return {
        exists: (await pathExists(resolvedPath)) ? "yes" as const : "no" as const,
        rawPath: target,
        resolvedPath,
      };
    })
  );

  return {
    overwriteRedirectTargets,
    workingDirectory,
  };
}

export async function getDestructiveCommandReason(
  client: LlmClient,
  config: AgentConfig,
  command: string,
  options?: {
    workingDirectory?: string;
  }
): Promise<null | string> {
  if (!config.requireRiskyConfirmation || command.includes(config.riskyConfirmationToken)) {
    return null;
  }

  const workingDirectory = resolve(options?.workingDirectory ?? process.cwd());
  if (
    isRuntimeMaintenanceRedirectWrite(command, workingDirectory) &&
    !isHighRiskDestructiveCommand(command)
  ) {
    return null;
  }

  const safetyAssessment = await assessCommandSafety(
    client,
    command,
    await buildCommandSafetyContext(command, workingDirectory)
  );
  if (!safetyAssessment.isDestructive) {
    return null;
  }

  return safetyAssessment.reason;
}
