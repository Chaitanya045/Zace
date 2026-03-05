import { resolve } from "node:path";
import { z } from "zod";

import type { Tool, ToolExecutionContext, ToolResult } from "../../types/tool";

import { env } from "../../config/env";
import { ToolExecutionError } from "../../utils/errors";
import { logToolCall, logToolResult } from "../../utils/logger";
import { stableStringify } from "../../utils/stable-json";
import {
  collectZaceMarkerLines,
  inferChangedFilesFromRedirectTargets,
  parseChangedFilesFromMarkerLines,
  validateMarkerChangedFiles,
} from "./changed-files";
export {
  inferChangedFilesFromRedirectTargets,
  parseChangedFilesFromMarkerLines,
  validateMarkerChangedFiles,
} from "./changed-files";
import {
  collectGitSnapshot,
  deriveChangedFilesFromGitSnapshots,
} from "./git-snapshot";
export { deriveChangedFilesFromGitSnapshots } from "./git-snapshot";
import { collectLspFeedback } from "./lsp-feedback";
export { buildLspDiagnosticsOutput } from "./lsp-feedback";
import {
  buildExecutionMetadataSection,
  buildRenderedOutput,
  writeCommandArtifacts,
} from "./output-rendering";
import { deduplicatePaths } from "./path-utils";
import {
  getShellLabel,
  runSpawnedShellCommand,
} from "./process-lifecycle";
export { runSpawnedShellCommand, type SpawnedCommandResult } from "./process-lifecycle";

export const executeCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  outputLimitChars: z.number().int().positive().optional(),
  retryMaxDelayMs: z.number().int().nonnegative().optional(),
  timeout: z.number().int().positive().optional(),
});

const DEFAULT_TIMEOUT_MS = 120_000;

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

type ChangedFilesSource = "git_delta" | "inferred_redirect" | "marker";
type ProgressSignal = "files_changed" | "none" | "output_changed" | "success_without_changes";

export function buildExecuteCommandSignature(command: string, workingDirectory: string): string {
  const signaturePayload = {
    command: command.trim(),
    cwd: resolve(workingDirectory),
  };

  return `execute_command|${stableStringify(signaturePayload)}`;
}

export function detectCommandProgressSignal(input: {
  changedFiles: string[];
  stderr: string;
  stdout: string;
  success: boolean;
}): ProgressSignal {
  if (input.changedFiles.length > 0) {
    return "files_changed";
  }

  if (!input.success) {
    return "none";
  }

  return "success_without_changes";
}

export async function executeCommand(
  args: unknown,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const { command, cwd, env: commandEnv, outputLimitChars, timeout } = executeCommandSchema.parse(args);
    const effectiveOutputLimitChars = outputLimitChars ?? env.AGENT_TOOL_OUTPUT_LIMIT_CHARS;
    const effectiveWorkingDirectory = resolve(cwd ?? process.cwd());
    logToolCall("execute_command", {
      command,
      cwd,
      env: commandEnv,
      outputLimitChars,
      shell: getShellLabel(),
      timeout,
    });

    const policyResult = evaluateCommandPolicy(command);
    if (policyResult) {
      logToolResult({ output: policyResult.output, success: false });
      return policyResult;
    }

    const beforeGitSnapshot = await collectGitSnapshot(effectiveWorkingDirectory);
    const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;
    const execution = await runSpawnedShellCommand({
      abortSignal: context?.abortSignal,
      command,
      commandEnv,
      timeoutMs: effectiveTimeout,
      workingDirectory: effectiveWorkingDirectory,
    });

    const output = execution.stdout;
    const errorOutput = execution.stderr;
    const markerLines = collectZaceMarkerLines(output, errorOutput);
    const markerHintChangedFiles = parseChangedFilesFromMarkerLines(
      markerLines,
      effectiveWorkingDirectory
    );
    const inferredRedirectChangedFiles = inferChangedFilesFromRedirectTargets(
      command,
      effectiveWorkingDirectory
    );
    const afterGitSnapshot = await collectGitSnapshot(effectiveWorkingDirectory);
    const gitChangedFiles = deriveChangedFilesFromGitSnapshots(
      beforeGitSnapshot?.files ?? [],
      afterGitSnapshot?.files ?? []
    );
    const markerValidation = await validateMarkerChangedFiles({
      gitChangedFiles,
      markerChangedFiles: markerHintChangedFiles,
    });
    const changedFiles = deduplicatePaths([
      ...markerValidation.acceptedMarkerFiles,
      ...gitChangedFiles,
      ...inferredRedirectChangedFiles,
    ]);
    const changedFilesSource: ChangedFilesSource[] = [];
    if (markerValidation.acceptedMarkerFiles.length > 0) {
      changedFilesSource.push("marker");
    }
    if (gitChangedFiles.length > 0) {
      changedFilesSource.push("git_delta");
    }
    if (inferredRedirectChangedFiles.length > 0) {
      changedFilesSource.push("inferred_redirect");
    }
    const commandSignature = buildExecuteCommandSignature(command, effectiveWorkingDirectory);
    const progressSignal = detectCommandProgressSignal({
      changedFiles,
      stderr: errorOutput,
      stdout: output,
      success: execution.exitCode === 0 && !execution.timedOut && !execution.aborted,
    });
    const lspFeedback = await collectLspFeedback(changedFiles);

    const artifacts = await writeCommandArtifacts(command, output, errorOutput);
    const executionSection = buildExecutionMetadataSection({
      command,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      lifecycleEvent: execution.lifecycleEvent,
      signal: execution.signal,
      timedOut: execution.timedOut,
      workingDirectory: effectiveWorkingDirectory,
    });
    const renderedOutput = buildRenderedOutput(
      errorOutput,
      output,
      artifacts,
      effectiveOutputLimitChars,
      lspFeedback.outputSection
        ? [lspFeedback.outputSection, executionSection]
        : [executionSection]
    );
    const toolArtifacts = {
      aborted: execution.aborted,
      changedFiles,
      changedFilesSource,
      combinedPath: artifacts.combinedPath,
      commandSignature,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode ?? undefined,
      lifecycleEvent: execution.lifecycleEvent,
      lspConfigPath: resolve(env.AGENT_LSP_SERVER_CONFIG_PATH),
      lspDiagnosticsFiles: lspFeedback.diagnosticsFiles,
      lspDiagnosticsIncluded: Boolean(lspFeedback.outputSection),
      lspErrorCount: lspFeedback.errorCount,
      lspProbeAttempted: lspFeedback.probeAttempted,
      lspProbeSucceeded: lspFeedback.probeSucceeded,
      lspStatus: lspFeedback.status,
      lspStatusReason: lspFeedback.reason,
      markerChangedFilesAccepted: markerValidation.acceptedMarkerFiles,
      markerChangedFilesRejected: markerValidation.rejectedMarkerFiles,
      markerValidationAcceptedCount: markerValidation.acceptedMarkerFiles.length,
      markerValidationRejectedCount: markerValidation.rejectedMarkerFiles.length,
      outputLimitChars: effectiveOutputLimitChars,
      progressSignal,
      signal: execution.signal ?? undefined,
      stderrPath: artifacts.stderrPath,
      stderrTruncated: renderedOutput.stderrTruncated,
      stdoutPath: artifacts.stdoutPath,
      stdoutTruncated: renderedOutput.stdoutTruncated,
      timedOut: execution.timedOut,
    };

    if (execution.timedOut) {
      logToolResult({ output: renderedOutput.output, success: false });
      return {
        artifacts: toolArtifacts,
        error: `Command timed out after ${String(effectiveTimeout)}ms`,
        output: renderedOutput.output,
        success: false,
      };
    }

    if (execution.aborted) {
      logToolResult({ output: renderedOutput.output, success: false });
      return {
        artifacts: toolArtifacts,
        error: "Command aborted",
        output: renderedOutput.output,
        success: false,
      };
    }

    if (execution.exitCode !== 0) {
      const failureReason = execution.exitCode === null
        ? `Command terminated${execution.signal ? ` by signal ${execution.signal}` : ""}`
        : `Command failed with exit code ${String(execution.exitCode)}`;
      logToolResult({ output: renderedOutput.output, success: false });
      return {
        artifacts: toolArtifacts,
        error: failureReason,
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
