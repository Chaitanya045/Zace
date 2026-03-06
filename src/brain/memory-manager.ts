import type { BrainPaths } from "./paths";

import { BASE_SYSTEM_PROMPT } from "../prompts/system";
import { fsMkdir, fsReadFile, fsStat, fsWriteFile } from "../tools/system/fs";
import {
  createInitialFileImportanceMap,
  serializeFileImportanceMap,
} from "./file-importance-ranker";
import {
  createInitialMemoryGraphEdges,
  createInitialMemoryGraphNodes,
  serializeMemoryGraphEdges,
  serializeMemoryGraphNodes,
} from "./memory-graph-manager";
import { getBrainPaths, toWorkspaceRelativePath } from "./paths";
import { buildInitialRepoMapMarkdown, readRepositorySummarySource } from "./repo-mapper";
import {
  createInitialCompletedTasks,
  serializeCompletedTasks,
  serializeCurrentPlan,
} from "./task-planner";
import { createInitialCurrentPlan, createInitialWorkingMemory } from "./types";

export type BrainBootstrapResult = {
  createdDirectories: string[];
  createdFiles: string[];
  paths: BrainPaths;
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
