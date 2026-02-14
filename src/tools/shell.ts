import { z } from "zod";

import type { Tool, ToolResult } from "../types/tool";

import { env } from "../config/env";
import { ToolExecutionError } from "../utils/errors";
import { logToolCall, logToolResult } from "../utils/logger";

const executeCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().optional(),
});

const DEFAULT_TIMEOUT_MS = 120_000;
const RISKY_COMMAND_PATTERNS: Array<{ reason: string; regex: RegExp }> = [
  { reason: "rm command", regex: /\brm\b/iu },
  { reason: "force git push", regex: /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/iu },
  { reason: "git reset --hard", regex: /\bgit\s+reset\b[^\n]*\s--hard\b/iu },
  { reason: "git clean with force", regex: /\bgit\s+clean\b[^\n]*\s-[^\n]*f/iu },
  { reason: "recursive chmod", regex: /\bchmod\b[^\n]*\s-R\b/iu },
  { reason: "recursive chown", regex: /\bchown\b[^\n]*\s-R\b/iu },
];

function compilePolicyRegexes(patterns: string[], policyName: string): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, "u");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown regex error";
      throw new ToolExecutionError(
        `Invalid ${policyName} command pattern "${pattern}": ${reason}`
      );
    }
  });
}

const allowPolicyRegexes = compilePolicyRegexes(env.AGENT_COMMAND_ALLOW_PATTERNS, "allow");
const denyPolicyRegexes = compilePolicyRegexes(env.AGENT_COMMAND_DENY_PATTERNS, "deny");

function getShellCommand(command: string): ReturnType<typeof Bun.$> {
  if (process.platform === "win32") {
    return Bun.$`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${command}`;
  }

  return Bun.$`sh -c ${command}`;
}

function getShellLabel(): string {
  if (process.platform === "win32") {
    return "powershell";
  }

  return "sh";
}

function getRiskyReasons(command: string): string[] {
  return RISKY_COMMAND_PATTERNS.filter((entry) => entry.regex.test(command)).map(
    (entry) => entry.reason
  );
}

function hasToken(command: string, token: string): boolean {
  return command.includes(token);
}

function evaluateCommandPolicy(command: string): ToolResult | undefined {
  const denyMatch = denyPolicyRegexes.find((regex) => regex.test(command));
  if (denyMatch) {
    return {
      error: "Command blocked by deny policy",
      output: `Command rejected by deny pattern: ${denyMatch.source}`,
      success: false,
    };
  }

  if (allowPolicyRegexes.length > 0) {
    const isAllowed = allowPolicyRegexes.some((regex) => regex.test(command));
    if (!isAllowed) {
      return {
        error: "Command blocked by allow policy",
        output:
          "Command did not match any allow patterns. Update AGENT_COMMAND_ALLOW_PATTERNS to permit it.",
        success: false,
      };
    }
  }

  if (env.AGENT_REQUIRE_RISKY_CONFIRMATION) {
    const riskyReasons = getRiskyReasons(command);
    if (riskyReasons.length > 0 && !hasToken(command, env.AGENT_RISKY_CONFIRMATION_TOKEN)) {
      return {
        error: "Explicit confirmation required for risky command",
        output:
          `Risky command detected (${riskyReasons.join(", ")}). ` +
          `Add confirmation token "${env.AGENT_RISKY_CONFIRMATION_TOKEN}" to proceed.`,
        success: false,
      };
    }
  }

  return undefined;
}

async function executeCommand(args: unknown): Promise<ToolResult> {
  try {
    const { command, cwd, env, timeout } = executeCommandSchema.parse(args);
    logToolCall("execute_command", { command, cwd, env, shell: getShellLabel(), timeout });

    const policyResult = evaluateCommandPolicy(command);
    if (policyResult) {
      logToolResult({ output: policyResult.output, success: false });
      return policyResult;
    }

    const proc = getShellCommand(command).cwd(cwd ?? process.cwd()).quiet().nothrow();

    // Set custom environment variables if provided
    if (env) {
      proc.env(env as Record<string, string | undefined>);
    }

    // Handle timeout if specified
    let timeoutId: Timer | undefined;
    const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Command timed out after ${String(effectiveTimeout)}ms`));
      }, effectiveTimeout);
    });

    const result = await Promise.race([proc, timeoutPromise]);

    if (timeoutId) clearTimeout(timeoutId);

    const output = result.stdout.toString();
    const errorOutput = result.stderr.toString();

    if (result.exitCode !== 0) {
      const failedOutput = errorOutput || output;
      logToolResult({ output: failedOutput, success: false });
      return {
        error: `Command failed with exit code ${result.exitCode}`,
        output: failedOutput,
        success: false,
      };
    }

    const successOutput = output || "Command executed successfully (no output)";
    logToolResult({ output: successOutput, success: true });

    return {
      output: successOutput,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to execute command: ${message}`, error);
  }
}

export const shellTools: Tool[] = [
  {
    description:
      "Execute a shell command and return its output. Supports custom working directory, environment variables, and timeout.",
    execute: executeCommand,
    name: "execute_command",
    parameters: executeCommandSchema,
  },
];
