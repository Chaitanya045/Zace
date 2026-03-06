import type { PlannerPlanState } from "../agent/planner/schema";
import type { AgentContext, AgentState } from "../types/agent";
import type { ToolResult } from "../types/tool";
import type { BrainPaths } from "./paths";
import type { CurrentPlan, WorkingMemory } from "./types";

import { BASE_SYSTEM_PROMPT } from "../prompts/system";
import { fsMkdir, fsReadFile, fsStat, fsWriteFile } from "../tools/system/fs";
import {
  createInitialFileImportanceMap,
  recomputeTouchedFileImportance,
  serializeFileImportanceMap,
} from "./file-importance-ranker";
import {
  createInitialMemoryGraphEdges,
  createInitialMemoryGraphNodes,
  serializeMemoryGraphEdges,
  serializeMemoryGraphNodes,
  updateMemoryGraphForTransition,
} from "./memory-graph-manager";
import { getBrainPaths, toWorkspaceRelativePath } from "./paths";
import {
  buildInitialRepoMapMarkdown,
  readRepositorySummarySource,
  updateRepoMapWithTouchedFiles,
} from "./repo-mapper";
import { recordCompactionSummary, recordTurnLongTermMemory } from "./session-logger";
import {
  createInitialCompletedTasks,
  serializeCompletedTasks,
  serializeCurrentPlan,
} from "./task-planner";
import {
  createInitialCurrentPlan,
  createInitialWorkingMemory,
  currentPlanSchema,
  workingMemorySchema,
} from "./types";

export type BrainBootstrapResult = {
  createdDirectories: string[];
  createdFiles: string[];
  paths: BrainPaths;
};

type PlannerTransitionInput = {
  action: "ask_user" | "blocked" | "complete" | "continue";
  contextFilePaths?: string[];
  planReasoning: string;
  planState?: PlannerPlanState;
  sessionId?: string;
  task: string;
  workspaceRoot?: string;
};

type ToolTransitionInput = {
  changedFiles: string[];
  contextFilePaths?: string[];
  planReasoning: string;
  sessionId?: string;
  task: string;
  toolName: string;
  toolResult: ToolResult;
  workspaceRoot?: string;
};

type TurnFinalizationInput = {
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
};

function buildIdentityMemoryMarkdown(input: {
  agentsContent?: string;
  readmeContent?: string;
}): string {
  const systemPromptLines = BASE_SYSTEM_PROMPT
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const purposeLines = systemPromptLines.slice(0, 5);
  const criticalRulesStartIndex = systemPromptLines.findIndex((line) => line === "CRITICAL RULES:");
  const criticalRules = criticalRulesStartIndex >= 0
    ? systemPromptLines
      .slice(criticalRulesStartIndex + 1)
      .filter((line) => /^\d+\./u.test(line))
      .slice(0, 6)
      .map((line) => line.replace(/^\d+\.\s*/u, ""))
    : [];
  const repoSummaryLines = Array.from(new Set([
    ...extractSummaryLines(input.agentsContent),
    ...extractSummaryLines(input.readmeContent),
  ])).slice(0, 5);

  const lines = [
    "# Identity Memory",
    "",
    "Persistent agent identity seed. Keep this concise because it is intended to be loaded into planner context.",
    "",
    "## Purpose",
    ...purposeLines.map((line) => `- ${line}`),
    "",
    "## Operating Principles",
    ...(
      criticalRules.length > 0
        ? criticalRules.map((line) => `- ${line}`)
        : [
            "- Prefer small, reversible changes.",
            "- Route side effects through typed tools.",
            "- Follow existing repository patterns before inventing new ones.",
          ]
    ),
    "",
    "## Repository Summary",
    ...(
      repoSummaryLines.length > 0
        ? repoSummaryLines.map((line) => `- ${line}`)
        : [
            "- Zace is a CLI coding agent built with Bun + TypeScript.",
            "- The repository uses a planner-executor architecture with a strict tool boundary.",
          ]
    ),
    "",
    "## Seed Source",
    "- Derived during bootstrap from `src/prompts/system.ts`, `AGENTS.md`, and `README.md`.",
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function buildKnowledgeMemoryMarkdown(): string {
  return `${[
    "# Knowledge Memory",
    "",
    "Stable repository facts discovered over time should be appended here.",
    "",
  ].join("\n")}\n`;
}

function buildDecisionMemoryMarkdown(): string {
  return `${[
    "# Decision Memory",
    "",
    "Record durable architectural decisions using this format:",
    "",
    "Decision:",
    "Reason:",
    "Date:",
    "Files affected:",
    "",
  ].join("\n")}\n`;
}

function extractSummaryLines(content: string | undefined): string[] {
  if (!content) {
    return [];
  }

  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) =>
      Boolean(line) &&
      (
        line.startsWith("- ") ||
        line.toLowerCase().includes("zace is") ||
        line.toLowerCase().includes("planner-executor") ||
        line.toLowerCase().includes("typed tools")
      )
    )
    .map((line) => line.replace(/^[-*]\s*/u, ""))
    .slice(0, 5);
}

async function readExistingFile(pathValue: string): Promise<string | undefined> {
  try {
    return await fsReadFile(pathValue, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function parseJsonFile<T>(
  pathValue: string,
  safeParse: (value: unknown) => {
    data: T;
    success: boolean;
  },
  fallback: T
): Promise<T> {
  try {
    const content = await fsReadFile(pathValue, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const validated = safeParse(parsed);
    return validated.success ? validated.data : fallback;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    return fallback;
  }
}

function appendRecentDecision(recentDecisions: string[], reasoning: string): string[] {
  if (!/\b(decision|decide|architecture|architectural|convention|policy|standardize|switch)\b/iu.test(reasoning)) {
    return recentDecisions;
  }

  const normalizedDecision = clipText(reasoning, 160);
  return Array.from(new Set([...recentDecisions, normalizedDecision])).slice(-5);
}

function clipText(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 16).trimEnd()}...[truncated]`;
}

function deduplicatePaths(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function deriveRelevantFilesFromCurrentPlan(currentPlan: CurrentPlan): string[] {
  if (currentPlan.currentStepId) {
    const currentStep = currentPlan.steps.find((step) => step.id === currentPlan.currentStepId);
    if (currentStep) {
      return currentStep.relevantFiles;
    }
  }

  return currentPlan.steps.flatMap((step) => step.relevantFiles);
}

function normalizeWorkspacePaths(workspaceRoot: string, values: string[]): string[] {
  return deduplicatePaths(
    values.map((value) => {
      if (!value) {
        return "";
      }

      return value.startsWith("/")
        ? toWorkspaceRelativePath(workspaceRoot, value)
        : value.replace(/\\/gu, "/");
    })
  );
}

async function readCurrentPlan(paths: BrainPaths): Promise<CurrentPlan> {
  return await parseJsonFile(
    paths.currentPlanFile,
    (value) => currentPlanSchema.safeParse(value),
    createInitialCurrentPlan()
  );
}

async function readWorkingMemory(paths: BrainPaths): Promise<WorkingMemory> {
  return await parseJsonFile(
    paths.workingMemoryFile,
    (value) => workingMemorySchema.safeParse(value),
    createInitialWorkingMemory()
  );
}

async function writeWorkingMemory(paths: BrainPaths, workingMemory: WorkingMemory): Promise<void> {
  await fsWriteFile(paths.workingMemoryFile, `${JSON.stringify(workingMemory, null, 2)}\n`, "utf8");
}

function buildPlannerCurrentStep(input: {
  action: PlannerTransitionInput["action"];
  currentPlan: CurrentPlan;
  planReasoning: string;
}): string {
  if (input.action === "complete") {
    return "Plan complete";
  }

  const activeStep = input.currentPlan.currentStepId
    ? input.currentPlan.steps.find((step) => step.id === input.currentPlan.currentStepId)
    : undefined;

  return clipText(activeStep?.title ?? input.planReasoning, 120);
}

function buildToolCurrentStep(input: {
  currentPlan: CurrentPlan;
  toolName: string;
  toolResult: ToolResult;
}): string {
  const activeStep = input.currentPlan.currentStepId
    ? input.currentPlan.steps.find((step) => step.id === input.currentPlan.currentStepId)
    : undefined;
  const toolStatus = input.toolResult.success ? "succeeded" : "failed";
  const detail = activeStep?.title ?? `${input.toolName} ${toolStatus}`;
  return clipText(detail, 120);
}

async function ensureDirectory(
  pathValue: string,
  createdDirectories: string[],
  workspaceRoot: string
): Promise<void> {
  try {
    await fsStat(pathValue);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await fsMkdir(pathValue, { recursive: true });
  createdDirectories.push(toWorkspaceRelativePath(workspaceRoot, pathValue));
}

async function ensureFile(
  pathValue: string,
  content: string,
  createdFiles: string[],
  workspaceRoot: string
): Promise<void> {
  const existing = await readExistingFile(pathValue);
  if (existing !== undefined) {
    return;
  }

  await fsWriteFile(pathValue, content, "utf8");
  createdFiles.push(toWorkspaceRelativePath(workspaceRoot, pathValue));
}

export async function ensureBrainStructure(input?: {
  workspaceRoot?: string;
}): Promise<BrainBootstrapResult> {
  const workspaceRoot = input?.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const summarySource = await readRepositorySummarySource(workspaceRoot);

  for (const directoryPath of [
    paths.rootDirectory,
    paths.brainDirectory,
    paths.episodicLogsDirectory,
    paths.sessionLogsDirectory,
    paths.plannerDirectory,
    paths.memoryGraphDirectory,
    paths.summariesDirectory,
    paths.artifactsDirectory,
  ]) {
    await ensureDirectory(directoryPath, createdDirectories, workspaceRoot);
  }

  await ensureFile(
    paths.identityFile,
    buildIdentityMemoryMarkdown(summarySource),
    createdFiles,
    workspaceRoot
  );
  await ensureFile(paths.knowledgeFile, buildKnowledgeMemoryMarkdown(), createdFiles, workspaceRoot);
  await ensureFile(paths.decisionsFile, buildDecisionMemoryMarkdown(), createdFiles, workspaceRoot);
  await ensureFile(
    paths.repoMapFile,
    await buildInitialRepoMapMarkdown(workspaceRoot),
    createdFiles,
    workspaceRoot
  );
  await ensureFile(
    paths.workingMemoryFile,
    `${JSON.stringify(createInitialWorkingMemory(), null, 2)}\n`,
    createdFiles,
    workspaceRoot
  );
  await ensureFile(
    paths.currentPlanFile,
    serializeCurrentPlan(createInitialCurrentPlan()),
    createdFiles,
    workspaceRoot
  );
  await ensureFile(
    paths.completedTasksFile,
    serializeCompletedTasks(createInitialCompletedTasks()),
    createdFiles,
    workspaceRoot
  );
  await ensureFile(
    paths.nodesFile,
    serializeMemoryGraphNodes(createInitialMemoryGraphNodes()),
    createdFiles,
    workspaceRoot
  );
  await ensureFile(
    paths.edgesFile,
    serializeMemoryGraphEdges(createInitialMemoryGraphEdges()),
    createdFiles,
    workspaceRoot
  );
  await ensureFile(
    paths.fileImportanceFile,
    serializeFileImportanceMap(createInitialFileImportanceMap()),
    createdFiles,
    workspaceRoot
  );

  return {
    createdDirectories,
    createdFiles,
    paths,
  };
}

export async function initializeTurnWorkingMemory(input: {
  sessionId?: string;
  task: string;
  workspaceRoot?: string;
}): Promise<WorkingMemory> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const [currentPlan, existingWorkingMemory] = await Promise.all([
    readCurrentPlan(paths),
    readWorkingMemory(paths),
  ]);
  const relevantFiles = deduplicatePaths([
    ...existingWorkingMemory.relevantFiles,
    ...deriveRelevantFilesFromCurrentPlan(currentPlan),
  ]);
  const nextWorkingMemory: WorkingMemory = {
    activePlanStepId: currentPlan.currentStepId,
    currentStep: existingWorkingMemory.currentStep ?? "startup",
    goal: input.task,
    lastUpdatedAt: new Date().toISOString(),
    recentDecisions: existingWorkingMemory.recentDecisions,
    relevantFiles,
    sessionId: input.sessionId ?? existingWorkingMemory.sessionId,
  };

  await writeWorkingMemory(paths, nextWorkingMemory);
  return nextWorkingMemory;
}

export async function recordPlannerTransition(
  input: PlannerTransitionInput
): Promise<WorkingMemory> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const [currentPlan, existingWorkingMemory] = await Promise.all([
    readCurrentPlan(paths),
    readWorkingMemory(paths),
  ]);
  const planStateRelevantFiles = input.planState
    ? input.planState.steps.flatMap((step) => step.relevantFiles ?? [])
    : [];
  const relevantFiles = deduplicatePaths([
    ...existingWorkingMemory.relevantFiles,
    ...(input.contextFilePaths ?? []),
    ...deriveRelevantFilesFromCurrentPlan(currentPlan),
    ...planStateRelevantFiles,
  ]);
  const nextWorkingMemory: WorkingMemory = {
    activePlanStepId: currentPlan.currentStepId ?? input.planState?.currentStepId ?? null,
    currentStep: buildPlannerCurrentStep({
      action: input.action,
      currentPlan,
      planReasoning: input.planReasoning,
    }),
    goal: currentPlan.goal ?? input.planState?.goal ?? input.task,
    lastUpdatedAt: new Date().toISOString(),
    recentDecisions: appendRecentDecision(existingWorkingMemory.recentDecisions, input.planReasoning),
    relevantFiles,
    sessionId: input.sessionId ?? existingWorkingMemory.sessionId,
  };

  await writeWorkingMemory(paths, nextWorkingMemory);
  return nextWorkingMemory;
}

export async function recordToolTransition(input: ToolTransitionInput): Promise<WorkingMemory> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const [currentPlan, existingWorkingMemory] = await Promise.all([
    readCurrentPlan(paths),
    readWorkingMemory(paths),
  ]);
  const changedFiles = normalizeWorkspacePaths(workspaceRoot, input.changedFiles);
  const touchedFiles = deduplicatePaths([
    ...deriveRelevantFilesFromCurrentPlan(currentPlan),
    ...normalizeWorkspacePaths(workspaceRoot, input.contextFilePaths ?? []),
    ...changedFiles,
  ]);
  const nextWorkingMemory: WorkingMemory = {
    activePlanStepId: currentPlan.currentStepId,
    currentStep: buildToolCurrentStep({
      currentPlan,
      toolName: input.toolName,
      toolResult: input.toolResult,
    }),
    goal: currentPlan.goal ?? input.task,
    lastUpdatedAt: new Date().toISOString(),
    recentDecisions: appendRecentDecision(existingWorkingMemory.recentDecisions, input.planReasoning),
    relevantFiles: deduplicatePaths([
      ...existingWorkingMemory.relevantFiles,
      ...touchedFiles,
    ]),
    sessionId: input.sessionId ?? existingWorkingMemory.sessionId,
  };

  await writeWorkingMemory(paths, nextWorkingMemory);

  if (touchedFiles.length === 0) {
    return nextWorkingMemory;
  }

  const graphState = await updateMemoryGraphForTransition({
    changedFiles,
    reasoning: input.planReasoning,
    sessionId: input.sessionId,
    task: input.task,
    touchedFiles,
    workspaceRoot,
  });
  await updateRepoMapWithTouchedFiles({
    changedFiles,
    touchedFiles,
    workspaceRoot,
  });
  await recomputeTouchedFileImportance({
    changedFiles,
    graphEdges: graphState.edges,
    graphNodes: graphState.nodes,
    touchedFiles,
    workspaceRoot,
  });

  return nextWorkingMemory;
}

export async function recordCompactionMemory(input: {
  relatedFiles?: string[];
  runId: string;
  sessionId?: string;
  step: number;
  summary: string;
  workspaceRoot?: string;
}): Promise<string> {
  return await recordCompactionSummary(input);
}

export async function recordTurnFinalization(
  input: TurnFinalizationInput
): Promise<{
  episodicLogPath: string;
  gitArtifactPath?: string;
}> {
  return await recordTurnLongTermMemory(input);
}
