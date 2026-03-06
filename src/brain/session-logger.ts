import { join } from "node:path";

import type { AgentContext, AgentState, AgentStep } from "../types/agent";
import type { BrainPaths } from "./paths";

import { fsAppendFile, fsReadFile, fsWriteFile } from "../tools/system/fs";
import { readGitChangeArtifact } from "../tools/system/git";
import { recordArtifactLinks, updateMemoryGraphForTransition } from "./memory-graph-manager";
import { getBrainPaths, toWorkspaceRelativePath } from "./paths";

function clipText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 16).trimEnd()}...[truncated]`;
}

function deduplicate(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeRelativePaths(
  workspaceRoot: string,
  paths: string[]
): string[] {
  return deduplicate(
    paths.map((pathValue) =>
      pathValue.startsWith("/")
        ? toWorkspaceRelativePath(workspaceRoot, pathValue)
        : pathValue.replace(/\\/gu, "/")
    )
  ).sort((left, right) => left.localeCompare(right));
}

function buildCompactionSummaryFileName(input: {
  date?: Date;
  runId: string;
  sessionId: string;
  step: number;
}): string {
  const timestamp = (input.date ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  return `compaction_${timestamp}_${input.sessionId}_${input.runId}_step-${String(input.step)}.md`;
}

function buildCompactionSummaryPath(
  paths: BrainPaths,
  input: {
    date?: Date;
    runId: string;
    sessionId: string;
    step: number;
  }
): string {
  return join(paths.summariesDirectory, buildCompactionSummaryFileName(input));
}

function buildGitArtifactFileName(input: {
  date?: Date;
  runId: string;
  sessionId: string;
}): string {
  const timestamp = (input.date ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  return `git_change_${timestamp}_${input.sessionId}_${input.runId}.md`;
}

function buildGitArtifactPath(
  paths: BrainPaths,
  input: {
    date?: Date;
    runId: string;
    sessionId: string;
  }
): string {
  return join(paths.artifactsDirectory, buildGitArtifactFileName(input));
}

export function buildSessionLogFileName(input: {
  date?: Date;
  runId: string;
  sessionId: string;
}): string {
  const timestamp = (input.date ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  return `session_${timestamp}_${input.sessionId}_${input.runId}.md`;
}

export function buildSessionLogPath(
  paths: BrainPaths,
  input: {
    date?: Date;
    runId: string;
    sessionId: string;
  }
): string {
  return join(paths.sessionLogsDirectory, buildSessionLogFileName(input));
}

function collectChangedFiles(
  context: AgentContext,
  workspaceRoot: string
): string[] {
  const changedFiles = context.steps.flatMap((step) => step.toolResult?.artifacts?.changedFiles ?? []);
  return normalizeRelativePaths(workspaceRoot, changedFiles);
}

function collectTouchedFiles(
  context: AgentContext,
  workspaceRoot: string
): string[] {
  const changedFiles = collectChangedFiles(context, workspaceRoot);
  const summarizedFiles = normalizeRelativePaths(
    workspaceRoot,
    Array.from(context.fileSummaries.keys())
  );

  return deduplicate([...changedFiles, ...summarizedFiles]).sort((left, right) =>
    left.localeCompare(right)
  );
}

function summarizeStep(step: AgentStep, workspaceRoot: string): string {
  const toolName = step.toolCall?.name;
  const changedFiles = normalizeRelativePaths(
    workspaceRoot,
    step.toolResult?.artifacts?.changedFiles ?? []
  );
  const toolStatus = step.toolResult
    ? step.toolResult.success
      ? "success"
      : "failed"
    : "no_tool";
  const segments = [
    `step ${String(step.step)}`,
    step.state,
    toolName ? `tool=${toolName}` : undefined,
    `status=${toolStatus}`,
    clipText(step.reasoning, 140),
    changedFiles.length > 0 ? `files=${changedFiles.join(", ")}` : undefined,
  ].filter(Boolean);

  return `- ${segments.join(" | ")}`;
}

function extractDecisionCandidate(input: {
  assistantMessage: string;
  context: AgentContext;
  finalReason: string;
}): string | undefined {
  const candidates = [
    input.assistantMessage,
    input.finalReason,
    ...input.context.steps.map((step) => step.reasoning),
  ]
    .map((value) => clipText(value, 160))
    .filter((value) =>
      /\b(decision|decide|architecture|architectural|convention|policy|standardize|switch|adopt)\b/iu
        .test(value)
    );

  return candidates.at(-1);
}

function extractKnowledgeCandidates(input: {
  assistantMessage: string;
  context: AgentContext;
}): string[] {
  const stableFactPatterns = [
    /\b(project|repository|repo)\s+(uses|is using|implements|relies on)\b/iu,
    /\b(authentication|auth|cache|caching|database|test framework|tests?)\s+(uses|is implemented with|implemented with|relies on)\b/iu,
    /\buses?\s+(bun|typescript|playwright|redis|jwt|zod|eslint|prettier)\b/iu,
  ];

  const sentences = [
    input.assistantMessage,
    ...input.context.steps.map((step) => step.reasoning),
  ]
    .flatMap((value) => value.split(/(?<=[.?!])\s+/u))
    .map((value) => clipText(value, 160))
    .filter((value) => stableFactPatterns.some((pattern) => pattern.test(value)));

  return deduplicate(sentences).slice(0, 4);
}

async function readExistingText(pathValue: string): Promise<string> {
  try {
    return await fsReadFile(pathValue, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function appendUniqueMarkdownLines(
  pathValue: string,
  lines: string[]
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  const existingContent = await readExistingText(pathValue);
  const nextLines = lines.filter((line) => !existingContent.includes(line));
  if (nextLines.length === 0) {
    return;
  }

  const prefix = existingContent.endsWith("\n") || existingContent.length === 0 ? "" : "\n";
  await fsAppendFile(pathValue, `${prefix}${nextLines.join("\n")}\n`, "utf8");
}

async function appendDecisionRecord(input: {
  decision: string;
  files: string[];
  paths: BrainPaths;
  timestamp: string;
}): Promise<boolean> {
  const normalizedDecision = clipText(input.decision, 160);
  const existingContent = await readExistingText(input.paths.decisionsFile);
  if (existingContent.includes(`Decision: ${normalizedDecision}`)) {
    return false;
  }

  const record = [
    "",
    "Decision:",
    normalizedDecision,
    "Reason:",
    "Derived from a completed agent run and persisted as long-term decision memory.",
    "Date:",
    input.timestamp,
    "Files affected:",
    input.files.length > 0 ? input.files.join(", ") : "(none)",
    "",
  ].join("\n");

  await fsAppendFile(input.paths.decisionsFile, record, "utf8");
  return true;
}

function buildEpisodicLogMarkdown(input: {
  artifactPaths: string[];
  assistantMessage: string;
  changedFiles: string[];
  context: AgentContext;
  endedAt: Date;
  finalReason: string;
  finalState: AgentState;
  startedAt: Date;
  success: boolean;
  task: string;
  touchedFiles: string[];
  workspaceRoot: string;
}): string {
  const stepLines = input.context.steps.length > 0
    ? input.context.steps.map((step) => summarizeStep(step, input.workspaceRoot))
    : ["- No execution steps were recorded."];
  const discoveries = deduplicate([
    input.changedFiles.length > 0
      ? `Changed files: ${input.changedFiles.join(", ")}`
      : "",
    input.touchedFiles.length > 0
      ? `Touched files: ${input.touchedFiles.join(", ")}`
      : "",
    clipText(input.finalReason, 160),
  ]).map((line) => `- ${line}`);
  const artifactLines = input.artifactPaths.length > 0
    ? input.artifactPaths.map((artifactPath) => `- ${artifactPath}`)
    : ["- None"];

  return [
    "# Episodic Session Log",
    "",
    `Session goal: ${input.task}`,
    "",
    "## Run",
    `- started_at: ${input.startedAt.toISOString()}`,
    `- ended_at: ${input.endedAt.toISOString()}`,
    `- final_state: ${input.finalState}`,
    `- success: ${String(input.success)}`,
    "",
    "## Steps",
    ...stepLines,
    "",
    "## Discoveries",
    ...discoveries,
    "",
    "## Outcome",
    `- ${clipText(input.assistantMessage, 200)}`,
    "",
    "## Relevant Files",
    ...(input.touchedFiles.length > 0
      ? input.touchedFiles.map((filePath) => `- ${filePath}`)
      : ["- None"]),
    "",
    "## Artifacts",
    ...artifactLines,
    "",
  ].join("\n");
}

export async function recordCompactionSummary(input: {
  relatedFiles?: string[];
  runId: string;
  sessionId?: string;
  step: number;
  summary: string;
  workspaceRoot?: string;
}): Promise<string> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const sessionId = input.sessionId ?? "standalone";
  const summaryPath = buildCompactionSummaryPath(paths, {
    runId: input.runId,
    sessionId,
    step: input.step,
  });
  const relativeSummaryPath = toWorkspaceRelativePath(workspaceRoot, summaryPath).replace(/\\/gu, "/");
  const content = [
    "# Compaction Summary",
    "",
    `Run ID: ${input.runId}`,
    `Step: ${String(input.step)}`,
    "",
    input.summary.trim(),
    "",
  ].join("\n");

  await fsWriteFile(summaryPath, content, "utf8");
  await recordArtifactLinks({
    artifactPath: relativeSummaryPath,
    description: `Compaction summary for run ${input.runId} at step ${String(input.step)}.`,
    edgeType: "generated_summary",
    relatedFiles: input.relatedFiles,
    sessionId: input.sessionId,
    workspaceRoot,
  });

  return relativeSummaryPath;
}

async function persistGitChangeArtifact(input: {
  changedFiles: string[];
  runId: string;
  sessionId?: string;
  workspaceRoot: string;
}): Promise<string | undefined> {
  if (input.changedFiles.length === 0) {
    return undefined;
  }

  const gitArtifact = await readGitChangeArtifact({
    changedFiles: input.changedFiles.map((filePath) => join(input.workspaceRoot, filePath)),
    workspaceRoot: input.workspaceRoot,
  });
  if (!gitArtifact) {
    return undefined;
  }

  const paths = getBrainPaths(input.workspaceRoot);
  const sessionId = input.sessionId ?? "standalone";
  const artifactPath = buildGitArtifactPath(paths, {
    runId: input.runId,
    sessionId,
  });
  const relativeArtifactPath = toWorkspaceRelativePath(input.workspaceRoot, artifactPath).replace(/\\/gu, "/");

  await fsWriteFile(artifactPath, gitArtifact.content, "utf8");
  await recordArtifactLinks({
    artifactPath: relativeArtifactPath,
    description: `Git change artifact for ${String(input.changedFiles.length)} changed file(s).`,
    relatedFiles: input.changedFiles,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
  });

  return relativeArtifactPath;
}

export async function recordTurnLongTermMemory(input: {
  assistantMessage: string;
  compactionSummaryPaths?: string[];
  context: AgentContext;
  endedAt: Date;
  finalReason: string;
  finalState: AgentState;
  runId: string;
  sessionId?: string;
  startedAt: Date;
  success: boolean;
  task: string;
  workspaceRoot?: string;
}): Promise<{
  episodicLogPath: string;
  gitArtifactPath?: string;
}> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const sessionId = input.sessionId ?? "standalone";
  const timestamp = input.endedAt.toISOString();
  const changedFiles = collectChangedFiles(input.context, workspaceRoot);
  const touchedFiles = collectTouchedFiles(input.context, workspaceRoot);
  const gitArtifactPath = await persistGitChangeArtifact({
    changedFiles,
    runId: input.runId,
    sessionId: input.sessionId,
    workspaceRoot,
  });
  const knowledgeCandidates = extractKnowledgeCandidates({
    assistantMessage: input.assistantMessage,
    context: input.context,
  }).map((line) => `- ${timestamp}: ${line}`);
  const decisionCandidate = extractDecisionCandidate({
    assistantMessage: input.assistantMessage,
    context: input.context,
    finalReason: input.finalReason,
  });
  const artifactPaths = deduplicate([
    ...(input.compactionSummaryPaths ?? []),
    gitArtifactPath ?? "",
  ]);
  const episodicLogPath = buildSessionLogPath(paths, {
    date: input.endedAt,
    runId: input.runId,
    sessionId,
  });
  const relativeEpisodicLogPath = toWorkspaceRelativePath(workspaceRoot, episodicLogPath).replace(/\\/gu, "/");
  const episodicLog = buildEpisodicLogMarkdown({
    artifactPaths,
    assistantMessage: input.assistantMessage,
    changedFiles,
    context: input.context,
    endedAt: input.endedAt,
    finalReason: input.finalReason,
    finalState: input.finalState,
    startedAt: input.startedAt,
    success: input.success,
    task: input.task,
    touchedFiles,
    workspaceRoot,
  });

  await Promise.all([
    fsWriteFile(episodicLogPath, episodicLog, "utf8"),
    appendUniqueMarkdownLines(paths.knowledgeFile, knowledgeCandidates),
  ]);
  await recordArtifactLinks({
    artifactPath: relativeEpisodicLogPath,
    description: `Episodic log for run ${input.runId}.`,
    edgeType: "generated_artifact",
    relatedFiles: touchedFiles,
    sessionId: input.sessionId,
    workspaceRoot,
  });

  if (decisionCandidate) {
    const decisionRecorded = await appendDecisionRecord({
      decision: decisionCandidate,
      files: touchedFiles,
      paths,
      timestamp,
    });
    if (decisionRecorded && touchedFiles.length > 0) {
      await updateMemoryGraphForTransition({
        changedFiles,
        reasoning: decisionCandidate,
        sessionId: input.sessionId,
        task: input.task,
        touchedFiles,
        workspaceRoot,
      });
    }
  }

  return {
    episodicLogPath: relativeEpisodicLogPath,
    gitArtifactPath,
  };
}
