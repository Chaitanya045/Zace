import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { LspDiagnostic } from "../../lsp/client";

import { env } from "../../config/env";
import {
  diagnostics as getLspDiagnostics,
  formatDiagnostic,
  getRuntimeInfo as getLspRuntimeInfo,
  probeFiles as probeLspFiles,
} from "../../lsp";
import { loadLspServersConfig, type LspServerConfig } from "../../lsp/config";
import { deduplicatePaths } from "./path-utils";

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
  ".ps1",
  ".sh",
  ".svg",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export type LspFeedback = {
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

function filterErrorDiagnostics(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) => diagnostic.severity === 1 || diagnostic.severity === undefined
  );
}

function getDarwinVarSymlinkAlternate(pathValue: string): null | string {
  if (process.platform !== "darwin") {
    return null;
  }

  const normalized = resolve(pathValue);
  if (normalized.startsWith("/private/var/")) {
    return `/var/${normalized.slice("/private/var/".length)}`;
  }

  if (normalized.startsWith("/var/")) {
    return `/private/var/${normalized.slice("/var/".length)}`;
  }

  return null;
}

function lookupDiagnosticsForChangedFile(input: {
  changedFile: string;
  diagnosticsByFile: Record<string, LspDiagnostic[]>;
}): LspDiagnostic[] {
  const normalizedChangedFile = resolve(input.changedFile);
  const candidates = [normalizedChangedFile];
  const alternate = getDarwinVarSymlinkAlternate(normalizedChangedFile);
  if (alternate) {
    candidates.push(alternate);
  }

  for (const candidate of candidates) {
    const diagnostics = input.diagnosticsByFile[candidate] ?? [];
    if (diagnostics.length > 0) {
      return diagnostics;
    }
  }

  return [];
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
    const diagnostics = lookupDiagnosticsForChangedFile({
      changedFile,
      diagnosticsByFile: input.diagnosticsByFile,
    });
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
    const errors = filterErrorDiagnostics(
      lookupDiagnosticsForChangedFile({
        changedFile: filePath,
        diagnosticsByFile: input.diagnosticsByFile,
      })
    );
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

export async function collectLspFeedback(changedFiles: string[]): Promise<LspFeedback> {
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
