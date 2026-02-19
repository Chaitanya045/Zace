import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";

import type { LspDiagnostic } from "../../lsp/client";
import type { Tool, ToolExecutionContext, ToolResult } from "../../types/tool";

import { env } from "../../config/env";
import {
  diagnostics as getLspDiagnostics,
  formatDiagnostic,
  getRuntimeInfo as getLspRuntimeInfo,
  probeFiles as probeLspFiles,
} from "../../lsp";
import { loadLspServersConfig, type LspServerConfig } from "../../lsp/config";
import { ToolExecutionError } from "../../utils/errors";
import { logToolCall, logToolResult } from "../../utils/logger";
import { stableStringify } from "../../utils/stable-json";
import {
  collectZaceMarkerLines,
  inferChangedFilesFromRedirectTargets,
  parseChangedFilesFromMarkerLines,
} from "./changed-files";
export {
  inferChangedFilesFromRedirectTargets,
  parseChangedFilesFromMarkerLines,
} from "./changed-files";
import {
  getShellLabel,
  runSpawnedShellCommand,
  type ProcessSignal,
  type SpawnedCommandResult,
} from "./process-lifecycle";
export { runSpawnedShellCommand, type SpawnedCommandResult } from "./process-lifecycle";

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
const NON_DIAGNOSTIC_SOURCE_EXTENSIONS = new Set([
  ".bmp",
  ".conf",
  ".css",
  ".csv",
  ".env",
  ".gif",
  ".html",
  ".ini",
  ".jpeg",
  ".jpg",
  ".json",
  ".jsonl",
  ".lock",
  ".log",
  ".md",
  ".png",
  ".svg",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

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

type CommandArtifacts = {
  combinedPath: string;
  stderrPath: string;
  stdoutPath: string;
};

type GitFileFingerprint = {
  mtimeMs: null | number;
  size: null | number;
};

type GitSnapshot = {
  files: Map<string, GitFileFingerprint>;
};

type LspFeedback = {
  diagnosticsFiles: string[];
  errorCount: number;
  outputSection?: string;
  probeAttempted: boolean;
  probeSucceeded: boolean;
  reason?: string;
  status:
    | "diagnostics"
    | "disabled"
    | "failed"
    | "no_active_server"
    | "no_applicable_files"
    | "no_changed_files"
    | "no_errors";
};

type ChangedFilesSource = "git_delta" | "inferred_redirect" | "marker";
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

async function fingerprintGitFile(filePath: string): Promise<GitFileFingerprint> {
  try {
    const fileStat = await stat(filePath);
    return {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    };
  } catch {
    return {
      mtimeMs: null,
      size: null,
    };
  }
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

  const fingerprints = new Map<string, GitFileFingerprint>();
  const fingerprintEntries = await Promise.all(
    Array.from(dirtyFiles, async (filePath) => [
      filePath,
      await fingerprintGitFile(filePath),
    ] as const)
  );

  for (const [filePath, fingerprint] of fingerprintEntries) {
    fingerprints.set(filePath, fingerprint);
  }

  return {
    files: fingerprints,
  };
}

export function deriveChangedFilesFromGitSnapshots(
  beforeFiles: Iterable<string> | Map<string, GitFileFingerprint>,
  afterFiles: Iterable<string> | Map<string, GitFileFingerprint>
): string[] {
  const normalizeSnapshot = (
    snapshot: Iterable<string> | Map<string, GitFileFingerprint>
  ): Map<string, GitFileFingerprint | undefined> => {
    if (snapshot instanceof Map) {
      return new Map(
        Array.from(snapshot.entries(), ([filePath, fingerprint]) => [resolve(filePath), fingerprint])
      );
    }

    return new Map(
      Array.from(snapshot, (filePath) => [resolve(filePath), undefined])
    );
  };

  const beforeMap = normalizeSnapshot(beforeFiles);
  const afterMap = normalizeSnapshot(afterFiles);
  const changedFiles = new Set<string>();

  for (const filePath of afterMap.keys()) {
    const hasBefore = beforeMap.has(filePath);
    const hasAfter = afterMap.has(filePath);

    if (!hasBefore && hasAfter) {
      changedFiles.add(filePath);
      continue;
    }

    const beforeFingerprint = beforeMap.get(filePath);
    const afterFingerprint = afterMap.get(filePath);
    if (!beforeFingerprint || !afterFingerprint) {
      continue;
    }

    if (
      beforeFingerprint.mtimeMs !== afterFingerprint.mtimeMs ||
      beforeFingerprint.size !== afterFingerprint.size
    ) {
      changedFiles.add(filePath);
    }
  }

  return Array.from(changedFiles).sort((left, right) => left.localeCompare(right));
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

  return "success_without_changes";
}

function filterErrorDiagnostics(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 1 || diagnostic.severity === undefined);
}

function formatLspStatusSection(input: {
  configPath: string;
  details?: string[];
  reason?: string;
  status: LspFeedback["status"];
}): string {
  const lines = [
    "[lsp]",
    `status: ${input.status}`,
    `config: ${input.configPath}`,
  ];
  if (input.reason) {
    lines.push(`reason: ${input.reason}`);
  }
  for (const detail of input.details ?? []) {
    if (!detail.trim()) {
      continue;
    }
    lines.push(detail);
  }
  return lines.join("\n");
}

function serverSupportsFile(server: Pick<LspServerConfig, "extensions">, filePath: string): boolean {
  if (server.extensions.length === 0) {
    return true;
  }

  return server.extensions.includes(extname(filePath));
}

function isLikelyDiagnosticSourceFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  if (!extension) {
    return false;
  }

  return !NON_DIAGNOSTIC_SOURCE_EXTENSIONS.has(extension);
}

async function resolveLspNoActiveServerReason(existingFiles: string[]): Promise<string> {
  const configPath = env.AGENT_LSP_SERVER_CONFIG_PATH;
  try {
    const loaded = await loadLspServersConfig(configPath);
    if (loaded.servers.length === 0) {
      return "no_servers_configured";
    }

    const hasMatchingServer = existingFiles.some((filePath) =>
      loaded.servers.some((server) => serverSupportsFile(server, filePath))
    );
    if (!hasMatchingServer) {
      return "no_matching_server_for_changed_files";
    }
  } catch (error) {
    return `lsp_config_parse_error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }

  const runtimeInfo = getLspRuntimeInfo();
  if (runtimeInfo.lastConfigError) {
    return `lsp_config_parse_error: ${runtimeInfo.lastConfigError}`;
  }

  if (runtimeInfo.brokenClientErrors.length > 0) {
    return `server_start_failed: ${runtimeInfo.brokenClientErrors[0]}`;
  }

  return "no_connected_lsp_client";
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
      probeAttempted: true,
      probeSucceeded: true,
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
    probeAttempted: true,
    probeSucceeded: true,
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
  const normalizedConfigPath = resolve(env.AGENT_LSP_SERVER_CONFIG_PATH);

  if (!env.AGENT_LSP_ENABLED) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
      probeAttempted: false,
      probeSucceeded: false,
      status: "disabled",
    };
  }

  if (changedFiles.length === 0) {
    return {
      diagnosticsFiles: [],
      errorCount: 0,
      probeAttempted: false,
      probeSucceeded: false,
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
      outputSection: formatLspStatusSection({
        configPath: normalizedConfigPath,
        details: ["No existing changed files available for diagnostics."],
        reason: "no_existing_changed_files",
        status: "no_changed_files",
      }),
      probeAttempted: false,
      probeSucceeded: false,
      reason: "no_existing_changed_files",
      status: "no_changed_files",
    };
  }

  try {
    const diagnosticCandidateFiles = deduplicatePaths(
      existingFiles.filter((filePath) => isLikelyDiagnosticSourceFile(filePath))
    );
    if (diagnosticCandidateFiles.length === 0) {
      return {
        diagnosticsFiles: [],
        errorCount: 0,
        outputSection: formatLspStatusSection({
          configPath: normalizedConfigPath,
          details: ["No applicable source files for LSP diagnostics."],
          reason: "no_applicable_changed_files",
          status: "no_applicable_files",
        }),
        probeAttempted: false,
        probeSucceeded: false,
        reason: "no_applicable_changed_files",
        status: "no_applicable_files",
      };
    }

    const loadedConfig = await loadLspServersConfig(env.AGENT_LSP_SERVER_CONFIG_PATH);
    if (loadedConfig.servers.length === 0) {
      return {
        diagnosticsFiles: [],
        errorCount: 0,
        outputSection: formatLspStatusSection({
          configPath: loadedConfig.filePath,
          details: ["No active LSP server for changed files."],
          reason: "no_servers_configured",
          status: "no_active_server",
        }),
        probeAttempted: false,
        probeSucceeded: false,
        reason: "no_servers_configured",
        status: "no_active_server",
      };
    }

    const applicableFiles = deduplicatePaths(
      diagnosticCandidateFiles.filter((filePath) =>
        loadedConfig.servers.some((server) => serverSupportsFile(server, filePath))
      )
    );
    if (applicableFiles.length === 0) {
      return {
        diagnosticsFiles: [],
        errorCount: 0,
        outputSection: formatLspStatusSection({
          configPath: loadedConfig.filePath,
          details: ["No applicable source files for active LSP servers."],
          reason: "no_matching_server_for_changed_files",
          status: "no_applicable_files",
        }),
        probeAttempted: false,
        probeSucceeded: false,
        reason: "no_matching_server_for_changed_files",
        status: "no_applicable_files",
      };
    }

    const probeResult = await probeLspFiles(applicableFiles);
    if (probeResult.status === "failed") {
      const reason = probeResult.reason ?? "probe_failed";
      return {
        diagnosticsFiles: [],
        errorCount: 0,
        outputSection: formatLspStatusSection({
          configPath: loadedConfig.filePath,
          details: ["LSP diagnostics probe failed."],
          reason,
          status: "failed",
        }),
        probeAttempted: true,
        probeSucceeded: false,
        reason,
        status: "failed",
      };
    }

    if (probeResult.status === "no_active_server") {
      const reason = probeResult.reason ?? await resolveLspNoActiveServerReason(applicableFiles);
      return {
        diagnosticsFiles: [],
        errorCount: 0,
        outputSection: formatLspStatusSection({
          configPath: loadedConfig.filePath,
          details: ["No active LSP server for changed files."],
          reason,
          status: "no_active_server",
        }),
        probeAttempted: true,
        probeSucceeded: false,
        reason,
        status: "no_active_server",
      };
    }

    const diagnosticsByFile = await getLspDiagnostics();
    const formatted = buildLspDiagnosticsOutput({
      changedFiles: applicableFiles,
      diagnosticsByFile,
      maxDiagnosticsPerFile: env.AGENT_LSP_MAX_DIAGNOSTICS_PER_FILE,
      maxFilesInOutput: env.AGENT_LSP_MAX_FILES_IN_OUTPUT,
    });
    if (formatted.outputSection) {
      return formatted;
    }

    return {
      diagnosticsFiles: [],
      errorCount: 0,
      outputSection: formatLspStatusSection({
        configPath: loadedConfig.filePath,
        details: ["No error diagnostics reported for changed files."],
        status: "no_errors",
      }),
      probeAttempted: true,
      probeSucceeded: true,
      status: "no_errors",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error";
    return {
      diagnosticsFiles: [],
      errorCount: 0,
      outputSection: formatLspStatusSection({
        configPath: normalizedConfigPath,
        details: [`LSP diagnostics failed: ${reason}`],
        reason,
        status: "failed",
      }),
      probeAttempted: true,
      probeSucceeded: false,
      reason,
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

async function executeCommand(args: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
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
      abortSignal: context?.abortSignal,
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
    const inferredRedirectChangedFiles = inferChangedFilesFromRedirectTargets(
      command,
      effectiveWorkingDirectory
    );
    const afterGitSnapshot = await collectGitSnapshot(effectiveWorkingDirectory);
    const gitChangedFiles = deriveChangedFilesFromGitSnapshots(
      beforeGitSnapshot?.files ?? [],
      afterGitSnapshot?.files ?? []
    );
    const changedFiles = deduplicatePaths([
      ...markerChangedFiles,
      ...gitChangedFiles,
      ...inferredRedirectChangedFiles,
    ]);
    const changedFilesSource: ChangedFilesSource[] = [];
    if (markerChangedFiles.length > 0) {
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
