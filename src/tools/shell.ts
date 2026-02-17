import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
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
const EXECUTION_COMMAND_PREVIEW_CHARS = 600;
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

function getShellInvocation(command: string): { args: string[]; executable: string } {
  if (process.platform === "win32") {
    return {
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      executable: "powershell.exe",
    };
  }

  return {
    args: ["-c", command],
    executable: "sh",
  };
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
  status: "diagnostics" | "disabled" | "failed" | "no_active_server" | "no_changed_files" | "no_errors";
};

type ChangedFilesSource = "git_delta" | "marker";
type ProgressSignal = "files_changed" | "none" | "output_changed" | "success_without_changes";
type ProcessSignal = Exclude<Parameters<typeof process.kill>[1], number | undefined>;

export interface SpawnedCommandResult {
  aborted: boolean;
  durationMs: number;
  exitCode: null | number;
  lifecycleEvent: "abort" | "none" | "timeout";
  signal: null | ProcessSignal;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

type AbortSignalLike = {
  aborted: boolean;
  addEventListener: (
    type: "abort",
    listener: () => void,
    options?: {
      once?: boolean;
    }
  ) => void;
  removeEventListener: (type: "abort", listener: () => void) => void;
};

function buildCommandEnvironment(commandEnv?: Record<string, string>): Record<string, string | undefined> {
  if (!commandEnv) {
    return process.env as Record<string, string | undefined>;
  }

  return {
    ...process.env,
    ...commandEnv,
  };
}

function collectStreamOutput(stream: Readable): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    stream.on("error", rejectOutput);
    stream.on("end", () => {
      resolveOutput(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function killUnixProcessTree(pid: number, signal: ProcessSignal): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fallback to direct process kill if process group kill is unavailable.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // process already exited
  }
}

async function killWindowsProcessTree(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolveKill) => {
    const killArgs = ["/PID", String(pid), "/T"];
    if (force) {
      killArgs.push("/F");
    }
    const killProcess = spawn("taskkill", killArgs, {
      stdio: "ignore",
      windowsHide: true,
    });
    killProcess.once("error", () => {
      resolveKill();
    });
    killProcess.once("exit", () => {
      resolveKill();
    });
  });
}

async function killProcessTree(pid: number, signal: ProcessSignal): Promise<void> {
  if (pid <= 0 || !Number.isFinite(pid)) {
    return;
  }

  if (process.platform === "win32") {
    await killWindowsProcessTree(pid, signal === "SIGKILL");
    return;
  }

  killUnixProcessTree(pid, signal);
}

export async function runSpawnedShellCommand(input: {
  abortSignal?: AbortSignalLike;
  command: string;
  commandEnv?: Record<string, string>;
  timeoutMs: number;
  workingDirectory: string;
}): Promise<SpawnedCommandResult> {
  const { args, executable } = getShellInvocation(input.command);
  const processHandle: ChildProcessWithoutNullStreams = spawn(executable, args, {
    cwd: input.workingDirectory,
    detached: process.platform !== "win32",
    env: buildCommandEnvironment(input.commandEnv),
    stdio: "pipe",
    windowsHide: true,
  });

  const startedAt = Date.now();
  const stdoutPromise = collectStreamOutput(processHandle.stdout);
  const stderrPromise = collectStreamOutput(processHandle.stderr);

  let lifecycleEvent: SpawnedCommandResult["lifecycleEvent"] = "none";
  let aborted = false;
  let terminationRequested = false;
  let timedOut = false;
  let forceKillTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const terminateProcessTree = (event: "abort" | "timeout"): void => {
    if (terminationRequested) {
      return;
    }
    terminationRequested = true;
    lifecycleEvent = event;
    aborted = event === "abort";
    timedOut = event === "timeout";
    const pid = processHandle.pid ?? 0;

    void killProcessTree(pid, "SIGTERM").finally(() => {
      forceKillTimeoutId = setTimeout(() => {
        void killProcessTree(pid, "SIGKILL");
      }, 1_000);
    });
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (input.timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      terminateProcessTree("timeout");
    }, input.timeoutMs);
  }

  const abortListener = (): void => {
    terminateProcessTree("abort");
  };
  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      abortListener();
    } else {
      input.abortSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  const exitInfo = await new Promise<{ exitCode: null | number; signal: null | ProcessSignal }>(
    (resolveExit, rejectExit) => {
      processHandle.once("error", (error) => {
        rejectExit(error);
      });
      processHandle.once("close", (exitCode, signal) => {
        resolveExit({
          exitCode,
          signal,
        });
      });
    }
  ).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (forceKillTimeoutId) {
      clearTimeout(forceKillTimeoutId);
    }
    if (input.abortSignal) {
      input.abortSignal.removeEventListener("abort", abortListener);
    }
  });

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const durationMs = Math.max(0, Date.now() - startedAt);

  return {
    aborted,
    durationMs,
    exitCode: exitInfo.exitCode,
    lifecycleEvent,
    signal: exitInfo.signal,
    stderr,
    stdout,
    timedOut,
  };
}

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
      status: "no_errors",
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
    status: "diagnostics",
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
  if (!env.AGENT_LSP_ENABLED) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
      status: "disabled",
    };
  }

  if (changedFiles.length === 0) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
      status: "no_changed_files",
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
      status: "no_changed_files",
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
        status: "no_active_server",
      };
    }

    return {
      diagnosticsFiles: [],
      errorCount: 0,
      outputSection: `[lsp]\nNo error diagnostics reported for changed files.`,
      status: "no_errors",
    };
  } catch (error) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
      outputSection: `[lsp]\nLSP diagnostics failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      status: "failed",
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

function buildExecutionMetadataSection(input: {
  command: string;
  durationMs: number;
  exitCode: null | number;
  lifecycleEvent: SpawnedCommandResult["lifecycleEvent"];
  signal: null | ProcessSignal;
  timedOut: boolean;
  workingDirectory: string;
}): string {
  const normalizedCommand = input.command.replaceAll(/\s+/gu, " ").trim();
  const commandPreview = normalizedCommand.length > EXECUTION_COMMAND_PREVIEW_CHARS
    ? `${normalizedCommand.slice(0, EXECUTION_COMMAND_PREVIEW_CHARS)} ...[truncated ${String(normalizedCommand.length - EXECUTION_COMMAND_PREVIEW_CHARS)} chars]`
    : normalizedCommand;

  const lines = [
    "[execution]",
    `shell: ${getShellLabel()}`,
    `cwd: ${input.workingDirectory}`,
    `duration_ms: ${String(input.durationMs)}`,
    `exit_code: ${input.exitCode === null ? "null" : String(input.exitCode)}`,
    `timed_out: ${input.timedOut ? "true" : "false"}`,
    `aborted: ${input.lifecycleEvent === "abort" ? "true" : "false"}`,
    `lifecycle_event: ${input.lifecycleEvent}`,
    `command: ${commandPreview}`,
  ];

  if (input.signal) {
    lines.push(`signal: ${input.signal}`);
  }

  return lines.join("\n");
}

function buildTruncationGuidanceSection(input: {
  artifacts: CommandArtifacts;
  outputLimitChars: number;
}): string {
  return [
    "[truncation]",
    `Output truncated to ${String(input.outputLimitChars)} chars per stream.`,
    "Inspect full logs with:",
    `tail -n 200 "${input.artifacts.combinedPath}"`,
    `sed -n '1,200p' "${input.artifacts.combinedPath}"`,
    `rg -n "error|warn|fail|exception" "${input.artifacts.combinedPath}"`,
    `tail -n 200 "${input.artifacts.stdoutPath}"`,
    `tail -n 200 "${input.artifacts.stderrPath}"`,
  ].join("\n");
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
    sections.push(
      buildTruncationGuidanceSection({
        artifacts,
        outputLimitChars,
      })
    );
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
    const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;
    const execution = await runSpawnedShellCommand({
      command,
      commandEnv,
      timeoutMs: effectiveTimeout,
      workingDirectory: effectiveWorkingDirectory,
    });

    const output = execution.stdout;
    const errorOutput = execution.stderr;
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
      lspDiagnosticsFiles: lspFeedback.diagnosticsFiles,
      lspDiagnosticsIncluded: Boolean(lspFeedback.outputSection),
      lspErrorCount: lspFeedback.errorCount,
      lspStatus: lspFeedback.status,
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
