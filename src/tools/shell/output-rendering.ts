import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { env } from "../../config/env";
import { collectZaceMarkerLines } from "./changed-files";
import {
  getShellLabel,
  type ProcessSignal,
  type SpawnedCommandResult,
} from "./process-lifecycle";

const EXECUTION_COMMAND_PREVIEW_CHARS = 600;

export type CommandArtifacts = {
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

export async function writeCommandArtifacts(
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

export function buildExecutionMetadataSection(input: {
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

export function buildRenderedOutput(
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
