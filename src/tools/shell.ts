import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import type { Tool, ToolResult } from "../types/tool";

import { env } from "../config/env";
import { ToolExecutionError } from "../utils/errors";
import { logToolCall, logToolResult } from "../utils/logger";

const executeCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  outputLimitChars: z.number().int().positive().optional(),
  retryMaxDelayMs: z.number().int().nonnegative().optional(),
  timeout: z.number().int().positive().optional(),
});

const DEFAULT_TIMEOUT_MS = 120_000;
const ZACE_MARKER_LINE_REGEX = /^ZACE_[A-Z0-9_]+\|.*$/u;

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

  return undefined;
}

type CommandArtifacts = {
  combinedPath: string;
  stderrPath: string;
  stdoutPath: string;
};

function truncateOutput(output: string, limit: number): { output: string; truncated: boolean } {
  if (output.length <= limit) {
    return {
      output,
      truncated: false,
    };
  }

  return {
    output: `${output.slice(0, limit)}\n...[truncated ${String(output.length - limit)} chars]`,
    truncated: true,
  };
}

function collectZaceMarkerLines(stdout: string, stderr: string): string[] {
  const markerLines: string[] = [];
  const seen = new Set<string>();

  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || !ZACE_MARKER_LINE_REGEX.test(trimmed) || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    markerLines.push(trimmed);
  }

  return markerLines;
}

async function writeCommandArtifacts(
  command: string,
  stdout: string,
  stderr: string
): Promise<CommandArtifacts> {
  const artifactDirectoryPath = resolve(env.AGENT_COMMAND_ARTIFACTS_DIR);
  const artifactId = randomUUID();
  const stdoutPath = join(artifactDirectoryPath, `${artifactId}.stdout.log`);
  const stderrPath = join(artifactDirectoryPath, `${artifactId}.stderr.log`);
  const combinedPath = join(artifactDirectoryPath, `${artifactId}.combined.log`);

  const combinedOutput = [
    `COMMAND: ${command}`,
    "",
    "[STDOUT]",
    stdout,
    "",
    "[STDERR]",
    stderr,
    "",
  ].join("\n");

  await mkdir(artifactDirectoryPath, { recursive: true });
  await Promise.all([
    writeFile(stdoutPath, stdout, "utf8"),
    writeFile(stderrPath, stderr, "utf8"),
    writeFile(combinedPath, combinedOutput, "utf8"),
  ]);

  return {
    combinedPath,
    stderrPath,
    stdoutPath,
  };
}

function buildRenderedOutput(
  stderr: string,
  stdout: string,
  artifacts: CommandArtifacts,
  outputLimitChars: number
): {
  output: string;
  stderrTruncated: boolean;
  stdoutTruncated: boolean;
} {
  const truncatedStdout = truncateOutput(stdout, outputLimitChars);
  const truncatedStderr = truncateOutput(stderr, outputLimitChars);
  const markerLines = collectZaceMarkerLines(stdout, stderr);

  const sections = [
    `[stdout]\n${truncatedStdout.output || "(empty)"}`,
    `[stderr]\n${truncatedStderr.output || "(empty)"}`,
    `[artifacts]\nstdout: ${artifacts.stdoutPath}\nstderr: ${artifacts.stderrPath}\ncombined: ${artifacts.combinedPath}`,
  ];

  if (markerLines.length > 0) {
    sections.push(markerLines.join("\n"));
  }

  if (truncatedStdout.truncated || truncatedStderr.truncated) {
    sections.unshift(`Output truncated to ${String(outputLimitChars)} chars per stream.`);
  }

  return {
    output: sections.join("\n\n"),
    stderrTruncated: truncatedStderr.truncated,
    stdoutTruncated: truncatedStdout.truncated,
  };
}

async function executeCommand(args: unknown): Promise<ToolResult> {
  try {
    const { command, cwd, env: commandEnv, outputLimitChars, timeout } = executeCommandSchema.parse(args);
    const effectiveOutputLimitChars = outputLimitChars ?? env.AGENT_TOOL_OUTPUT_LIMIT_CHARS;
    logToolCall("execute_command", { command, cwd, env: commandEnv, outputLimitChars, shell: getShellLabel(), timeout });

    const policyResult = evaluateCommandPolicy(command);
    if (policyResult) {
      logToolResult({ output: policyResult.output, success: false });
      return policyResult;
    }

    const proc = getShellCommand(command).cwd(cwd ?? process.cwd()).quiet().nothrow();

    // Set custom environment variables if provided
    if (commandEnv) {
      proc.env(commandEnv as Record<string, string | undefined>);
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
    const artifacts = await writeCommandArtifacts(command, output, errorOutput);
    const renderedOutput = buildRenderedOutput(
      errorOutput,
      output,
      artifacts,
      effectiveOutputLimitChars
    );
    const toolArtifacts = {
      combinedPath: artifacts.combinedPath,
      outputLimitChars: effectiveOutputLimitChars,
      stderrPath: artifacts.stderrPath,
      stderrTruncated: renderedOutput.stderrTruncated,
      stdoutPath: artifacts.stdoutPath,
      stdoutTruncated: renderedOutput.stdoutTruncated,
    };

    if (result.exitCode !== 0) {
      logToolResult({ output: renderedOutput.output, success: false });
      return {
        artifacts: toolArtifacts,
        error: `Command failed with exit code ${result.exitCode}`,
        output: renderedOutput.output,
        success: false,
      };
    }

    logToolResult({ output: renderedOutput.output, success: true });

    return {
      artifacts: toolArtifacts,
      output: renderedOutput.output,
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
