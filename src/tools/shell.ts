import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import type { LspDiagnostic } from "../lsp/client";
import type { Tool, ToolResult } from "../types/tool";

import { env } from "../config/env";
import {
  diagnostics as getLspDiagnostics,
  formatDiagnostic,
  status as getLspStatus,
  touchFiles as touchLspFiles,
} from "../lsp";
import { ToolExecutionError } from "../utils/errors";
import { logToolCall, logToolResult } from "../utils/logger";
import { stableStringify } from "../utils/stable-json";

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
const ZACE_FILE_CHANGED_PREFIX = "ZACE_FILE_CHANGED|";

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

type GitSnapshot = {
  files: Set<string>;
};

type LspFeedback = {
  diagnosticsFiles: string[];
  errorCount: number;
  outputSection?: string;
};

type ChangedFilesSource = "git_delta" | "marker";
type ProgressSignal = "files_changed" | "none" | "output_changed" | "success_without_changes";

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

function normalizeCommandPath(pathValue: string, workingDirectory: string): string {
  const trimmed = pathValue.trim().replace(/^["']|["']$/gu, "");
  if (!trimmed) {
    return "";
  }

  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }

  return resolve(workingDirectory, trimmed);
}

export function parseChangedFilesFromMarkerLines(
  markerLines: string[],
  workingDirectory: string
): string[] {
  const changedFiles = new Set<string>();

  for (const markerLine of markerLines) {
    if (!markerLine.startsWith(ZACE_FILE_CHANGED_PREFIX)) {
      continue;
    }

    const rawPath = markerLine.slice(ZACE_FILE_CHANGED_PREFIX.length).trim();
    if (!rawPath) {
      continue;
    }

    const normalized = normalizeCommandPath(rawPath, workingDirectory);
    if (!normalized) {
      continue;
    }
    changedFiles.add(normalized);
  }

  return Array.from(changedFiles).sort((left, right) => left.localeCompare(right));
}

async function runGitCommand(workingDirectory: string, args: string[]): Promise<{
  stderr: string;
  stdout: string;
  success: boolean;
}> {
  const processHandle = Bun.spawn({
    cmd: ["git", "-C", workingDirectory, ...args],
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new globalThis.Response(processHandle.stdout).text(),
    new globalThis.Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);

  return {
    stderr,
    stdout,
    success: exitCode === 0,
  };
}

async function resolveGitRepositoryRoot(workingDirectory: string): Promise<string | undefined> {
  const result = await runGitCommand(workingDirectory, ["rev-parse", "--show-toplevel"]);
  if (!result.success) {
    return undefined;
  }

  const repositoryRoot = result.stdout.trim();
  if (!repositoryRoot) {
    return undefined;
  }

  return resolve(repositoryRoot);
}

function parseGitPathList(rawOutput: string, repositoryRoot: string): Set<string> {
  const resolvedPaths = new Set<string>();
  for (const line of rawOutput.split(/\r?\n/u)) {
    const relativePath = line.trim();
    if (!relativePath) {
      continue;
    }
    resolvedPaths.add(resolve(repositoryRoot, relativePath));
  }
  return resolvedPaths;
}

async function collectGitSnapshot(workingDirectory: string): Promise<GitSnapshot | undefined> {
  const repositoryRoot = await resolveGitRepositoryRoot(workingDirectory);
  if (!repositoryRoot) {
    return undefined;
  }

  const [workingTreeDiff, indexDiff, untrackedFiles] = await Promise.all([
    runGitCommand(repositoryRoot, ["diff", "--name-only"]),
    runGitCommand(repositoryRoot, ["diff", "--name-only", "--cached"]),
    runGitCommand(repositoryRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  const dirtyFiles = new Set<string>();
  for (const result of [workingTreeDiff, indexDiff, untrackedFiles]) {
    if (!result.success) {
      continue;
    }
    const parsed = parseGitPathList(result.stdout, repositoryRoot);
    for (const filePath of parsed) {
      dirtyFiles.add(filePath);
    }
  }

  return {
    files: dirtyFiles,
  };
}

export function deriveChangedFilesFromGitSnapshots(
  beforeFiles: Iterable<string>,
  afterFiles: Iterable<string>
): string[] {
  const beforeSet = new Set(Array.from(beforeFiles, (pathValue) => resolve(pathValue)));
  const delta: string[] = [];
  for (const filePath of afterFiles) {
    const normalized = resolve(filePath);
    if (!beforeSet.has(normalized)) {
      delta.push(normalized);
    }
  }
  return delta.sort((left, right) => left.localeCompare(right));
}

function deduplicatePaths(paths: Iterable<string>): string[] {
  return Array.from(
    new Set(Array.from(paths, (pathValue) => resolve(pathValue)))
  ).sort((left, right) => left.localeCompare(right));
}

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

  if (input.stdout.trim().length > 0 || input.stderr.trim().length > 0) {
    return "output_changed";
  }

  return "success_without_changes";
}

function filterErrorDiagnostics(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 1 || diagnostic.severity === undefined);
}

export function buildLspDiagnosticsOutput(input: {
  changedFiles: string[];
  diagnosticsByFile: Record<string, LspDiagnostic[]>;
  maxDiagnosticsPerFile: number;
  maxFilesInOutput: number;
}): LspFeedback {
  const normalizedChangedFiles = deduplicatePaths(input.changedFiles);
  const diagnosticsFiles: string[] = [];
  const sections: string[] = [];
  let errorCount = 0;

  for (const changedFile of normalizedChangedFiles) {
    const diagnostics = input.diagnosticsByFile[changedFile] ?? [];
    const errors = filterErrorDiagnostics(diagnostics);
    if (errors.length === 0) {
      continue;
    }

    errorCount += errors.length;
    diagnosticsFiles.push(changedFile);
  }

  if (diagnosticsFiles.length === 0) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
    };
  }

  const limitedFiles = diagnosticsFiles.slice(0, input.maxFilesInOutput);
  sections.push(
    `[lsp]\nchanged_files: ${String(normalizedChangedFiles.length)}\ndiagnostic_files: ${String(diagnosticsFiles.length)}`
  );

  for (const filePath of limitedFiles) {
    const errors = filterErrorDiagnostics(input.diagnosticsByFile[filePath] ?? []);
    const limitedErrors = errors.slice(0, input.maxDiagnosticsPerFile);
    const lines = limitedErrors.map((diagnostic) => formatDiagnostic(diagnostic));
    if (errors.length > input.maxDiagnosticsPerFile) {
      lines.push(`... and ${String(errors.length - input.maxDiagnosticsPerFile)} more`);
    }
    sections.push(`<diagnostics file="${filePath}">\n${lines.join("\n")}\n</diagnostics>`);
  }

  if (diagnosticsFiles.length > input.maxFilesInOutput) {
    sections.push(`... and ${String(diagnosticsFiles.length - input.maxFilesInOutput)} more files with diagnostics`);
  }

  return {
    diagnosticsFiles,
    errorCount,
    outputSection: sections.join("\n\n"),
  };
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    const fileStat = await stat(pathValue);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function collectLspFeedback(changedFiles: string[]): Promise<LspFeedback> {
  if (!env.AGENT_LSP_ENABLED || changedFiles.length === 0) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
    };
  }

  const existingFiles = (
    await Promise.all(
      changedFiles.map(async (pathValue) => ({
        exists: await fileExists(pathValue),
        pathValue,
      }))
    )
  )
    .filter((item) => item.exists)
    .map((item) => item.pathValue);

  if (existingFiles.length === 0) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
      outputSection: `[lsp]\nNo existing changed files available for diagnostics.`,
    };
  }

  try {
    await touchLspFiles(existingFiles, true);
    const diagnosticsByFile = await getLspDiagnostics();
    const formatted = buildLspDiagnosticsOutput({
      changedFiles: existingFiles,
      diagnosticsByFile,
      maxDiagnosticsPerFile: env.AGENT_LSP_MAX_DIAGNOSTICS_PER_FILE,
      maxFilesInOutput: env.AGENT_LSP_MAX_FILES_IN_OUTPUT,
    });
    if (formatted.outputSection) {
      return formatted;
    }

    const lspStatuses = await getLspStatus();
    if (lspStatuses.length === 0) {
      return {
        diagnosticsFiles: [],
        errorCount: 0,
        outputSection:
          `[lsp]\nNo active LSP server for changed files.\n` +
          `Configure runtime servers in ${env.AGENT_LSP_SERVER_CONFIG_PATH}.`,
      };
    }

    return {
      diagnosticsFiles: [],
      errorCount: 0,
      outputSection: `[lsp]\nNo error diagnostics reported for changed files.`,
    };
  } catch (error) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
      outputSection: `[lsp]\nLSP diagnostics failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
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
  outputLimitChars: number,
  additionalSections: string[] = []
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

  for (const section of additionalSections) {
    if (!section.trim()) {
      continue;
    }
    sections.push(section);
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
    const effectiveWorkingDirectory = resolve(cwd ?? process.cwd());
    logToolCall("execute_command", { command, cwd, env: commandEnv, outputLimitChars, shell: getShellLabel(), timeout });

    const policyResult = evaluateCommandPolicy(command);
    if (policyResult) {
      logToolResult({ output: policyResult.output, success: false });
      return policyResult;
    }

    const beforeGitSnapshot = await collectGitSnapshot(effectiveWorkingDirectory);

    const proc = getShellCommand(command).cwd(effectiveWorkingDirectory).quiet().nothrow();

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
    const markerLines = collectZaceMarkerLines(output, errorOutput);
    const markerChangedFiles = parseChangedFilesFromMarkerLines(
      markerLines,
      effectiveWorkingDirectory
    );
    const afterGitSnapshot = await collectGitSnapshot(effectiveWorkingDirectory);
    const gitChangedFiles = deriveChangedFilesFromGitSnapshots(
      beforeGitSnapshot?.files ?? [],
      afterGitSnapshot?.files ?? []
    );
    const changedFiles = deduplicatePaths([...markerChangedFiles, ...gitChangedFiles]);
    const changedFilesSource: ChangedFilesSource[] = [];
    if (markerChangedFiles.length > 0) {
      changedFilesSource.push("marker");
    }
    if (gitChangedFiles.length > 0) {
      changedFilesSource.push("git_delta");
    }
    const commandSignature = buildExecuteCommandSignature(command, effectiveWorkingDirectory);
    const progressSignal = detectCommandProgressSignal({
      changedFiles,
      stderr: errorOutput,
      stdout: output,
      success: result.exitCode === 0,
    });
    const lspFeedback = await collectLspFeedback(changedFiles);

    const artifacts = await writeCommandArtifacts(command, output, errorOutput);
    const renderedOutput = buildRenderedOutput(
      errorOutput,
      output,
      artifacts,
      effectiveOutputLimitChars,
      lspFeedback.outputSection ? [lspFeedback.outputSection] : []
    );
    const toolArtifacts = {
      changedFiles,
      changedFilesSource,
      combinedPath: artifacts.combinedPath,
      commandSignature,
      lspDiagnosticsFiles: lspFeedback.diagnosticsFiles,
      lspDiagnosticsIncluded: Boolean(lspFeedback.outputSection),
      lspErrorCount: lspFeedback.errorCount,
      outputLimitChars: effectiveOutputLimitChars,
      progressSignal,
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
