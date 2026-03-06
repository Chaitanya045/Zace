import { join } from "node:path";

import { fsReaddir, fsReadFile, fsStat, fsWriteFile } from "../tools/system/fs";
import { getBrainPaths } from "./paths";

type RepoSummarySource = {
  agentsContent?: string;
  readmeContent?: string;
};

type SeedQueueItem = {
  absolutePath: string;
  depth: number;
  relativePath: string;
  topLevelArea: string;
};

const EXACT_PATH_DESCRIPTIONS = new Map<string, string>([
  [".env.example", "example runtime environment configuration"],
  ["AGENTS.md", "repository operating instructions for coding agents"],
  ["README.md", "repository overview and usage notes"],
  ["package.json", "Bun package manifest and scripts"],
  ["python", "Python UI/runtime support"],
  ["python/zace_tui", "Textual UI package and rendering logic"],
  ["src", "main TypeScript source tree"],
  ["src/agent", "runtime orchestration and loop phases"],
  ["src/cli", "CLI wiring and command definitions"],
  ["src/config", "validated boot-time configuration"],
  ["src/index.ts", "CLI entrypoint"],
  ["src/llm", "model client and compatibility pipeline"],
  ["src/lsp", "LSP runtime configuration and clients"],
  ["src/permission", "permission rules and memory"],
  ["src/prompts", "versioned planner/executor/system prompts"],
  ["src/session", "session storage and processing"],
  ["src/tools", "side-effect boundary and system wrappers"],
  ["src/types", "shared runtime contracts and schemas"],
  ["src/ui", "Textual bridge and plain fallback UI"],
  ["src/utils", "pure utility helpers"],
  ["tests", "automated test coverage and regression fixtures"],
  ["tsconfig.json", "TypeScript compiler configuration"],
]);

const ROOT_ENTRY_PRIORITY = new Map<string, number>([
  ["AGENTS.md", 1],
  ["README.md", 2],
  ["package.json", 3],
  ["tsconfig.json", 4],
  [".env.example", 5],
  ["src", 10],
  ["tests", 11],
  ["python", 12],
  ["docs", 13],
]);

const ALLOWED_TOP_LEVEL_SCAN_AREAS = new Set(["docs", "python", "scripts", "src", "tests"]);
const REPO_MAP_MAX_DEPTH = 2;
const REPO_MAP_MAX_ENTRIES = 48;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  ".zace",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
  "venv",
  "vendor",
]);

function collectSeedSummaryLines(input: RepoSummarySource): string[] {
  const candidateLines = [
    ...findMatchingLines(input.agentsContent, [
      "Zace is",
      "planner–executor",
      "planner-executor",
      "all side effects",
      "typed tools",
    ]),
    ...findMatchingLines(input.readmeContent, [
      "Zace is",
      "planner-executor",
      "typed tools",
      "Textual-based Python chat UI",
      "Runtime LSP diagnostics",
    ]),
  ];

  return Array.from(new Set(candidateLines)).slice(0, 5);
}

function findMatchingLines(content: string | undefined, matchers: string[]): string[] {
  if (!content) {
    return [];
  }

  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .filter((line) =>
      matchers.some((matcher) => line.toLowerCase().includes(matcher.toLowerCase()))
    )
    .map((line) => line.replace(/^[-*]\s*/u, ""))
    .slice(0, matchers.length);
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await fsStat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalWorkspaceFile(pathValue: string): Promise<string | undefined> {
  if (!(await pathExists(pathValue))) {
    return undefined;
  }

  return await fsReadFile(pathValue, "utf8");
}

function shouldSkipDirectory(name: string): boolean {
  return SKIPPED_DIRECTORY_NAMES.has(name);
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

function describeRepoPath(pathValue: string, isDirectory: boolean): string {
  const normalizedPath = normalizeRelativePath(pathValue).replace(/\/$/u, "");
  const exactDescription = EXACT_PATH_DESCRIPTIONS.get(normalizedPath);
  if (exactDescription) {
    return exactDescription;
  }

  if (normalizedPath.startsWith("src/")) {
    return isDirectory ? "TypeScript source area" : "TypeScript source file";
  }
  if (normalizedPath.startsWith("tests/")) {
    return isDirectory ? "test coverage area" : "test case or fixture";
  }
  if (normalizedPath.startsWith("python/")) {
    return isDirectory ? "Python UI/runtime area" : "Python UI/runtime file";
  }
  if (normalizedPath.startsWith("docs/")) {
    return isDirectory ? "documentation area" : "documentation file";
  }
  if (normalizedPath.startsWith("scripts/")) {
    return isDirectory ? "automation scripts area" : "automation script";
  }
  if (normalizedPath.endsWith(".json")) {
    return "configuration or metadata file";
  }
  if (normalizedPath.endsWith(".md")) {
    return "documentation or project note";
  }
  if (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".tsx")) {
    return "TypeScript source file";
  }
  if (normalizedPath.endsWith(".py")) {
    return "Python source file";
  }

  return isDirectory ? "workspace area" : "workspace file";
}

function shouldIncludeRootFile(name: string): boolean {
  return Boolean(
    ROOT_ENTRY_PRIORITY.has(name) ||
      name.endsWith(".json") ||
      name.endsWith(".md") ||
      name.endsWith(".toml") ||
      name.endsWith(".yml") ||
      name.endsWith(".yaml")
  );
}

function shouldIncludeSeedEntry(relativePath: string, isDirectory: boolean, depth: number): boolean {
  if (depth === 0) {
    return isDirectory || shouldIncludeRootFile(relativePath);
  }

  if (isDirectory) {
    return depth <= REPO_MAP_MAX_DEPTH;
  }

  return (
    relativePath.endsWith(".json") ||
    relativePath.endsWith(".md") ||
    relativePath.endsWith(".py") ||
    relativePath.endsWith(".ts") ||
    relativePath.endsWith(".tsx")
  );
}

function shouldDescendInto(relativePath: string, depth: number): boolean {
  if (depth >= REPO_MAP_MAX_DEPTH) {
    return false;
  }

  const topLevelArea = relativePath.split("/")[0] ?? relativePath;
  return ALLOWED_TOP_LEVEL_SCAN_AREAS.has(topLevelArea);
}

function formatRepoMapEntry(relativePath: string, isDirectory: boolean): string {
  const renderedPath = isDirectory ? `${relativePath}/` : relativePath;
  return `- \`${renderedPath}\` - ${describeRepoPath(relativePath, isDirectory)}`;
}

function sortDirectoryEntries(
  entries: Array<{ isDirectory: boolean; name: string }>,
  depth: number
): Array<{ isDirectory: boolean; name: string }> {
  return [...entries].sort((left, right) => {
    const leftPriority = depth === 0 ? ROOT_ENTRY_PRIORITY.get(left.name) ?? 999 : 999;
    const rightPriority = depth === 0 ? ROOT_ENTRY_PRIORITY.get(right.name) ?? 999 : 999;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

async function readDirectoryEntries(directoryPath: string): Promise<Array<{
  isDirectory: boolean;
  name: string;
}>> {
  try {
    const entries = await fsReaddir(directoryPath, { withFileTypes: true });
    return entries.map((entry) => ({
      isDirectory: entry.isDirectory(),
      name: entry.name,
    }));
  } catch {
    return [];
  }
}

async function collectWorkspaceSeedEntries(workspaceRoot: string): Promise<string[]> {
  const rootEntries = sortDirectoryEntries(await readDirectoryEntries(workspaceRoot), 0);
  const lines: string[] = [];
  const seenPaths = new Set<string>();
  const queue: SeedQueueItem[] = [];

  for (const entry of rootEntries) {
    if (entry.isDirectory && shouldSkipDirectory(entry.name)) {
      continue;
    }

    const relativePath = entry.name;
    if (shouldIncludeSeedEntry(relativePath, entry.isDirectory, 0) && !seenPaths.has(relativePath)) {
      seenPaths.add(relativePath);
      lines.push(formatRepoMapEntry(relativePath, entry.isDirectory));
    }

    if (entry.isDirectory && shouldDescendInto(relativePath, 0)) {
      queue.push({
        absolutePath: join(workspaceRoot, entry.name),
        depth: 1,
        relativePath,
        topLevelArea: relativePath,
      });
    }

    if (lines.length >= REPO_MAP_MAX_ENTRIES) {
      return lines.slice(0, REPO_MAP_MAX_ENTRIES);
    }
  }

  while (queue.length > 0 && lines.length < REPO_MAP_MAX_ENTRIES) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const currentEntries = sortDirectoryEntries(
      await readDirectoryEntries(current.absolutePath),
      current.depth
    );

    for (const entry of currentEntries) {
      if (entry.isDirectory && shouldSkipDirectory(entry.name)) {
        continue;
      }

      const relativePath = `${current.relativePath}/${entry.name}`;
      if (shouldIncludeSeedEntry(relativePath, entry.isDirectory, current.depth) && !seenPaths.has(relativePath)) {
        seenPaths.add(relativePath);
        lines.push(formatRepoMapEntry(relativePath, entry.isDirectory));
      }

      if (entry.isDirectory && shouldDescendInto(relativePath, current.depth)) {
        queue.push({
          absolutePath: join(current.absolutePath, entry.name),
          depth: current.depth + 1,
          relativePath,
          topLevelArea: current.topLevelArea,
        });
      }

      if (lines.length >= REPO_MAP_MAX_ENTRIES) {
        break;
      }
    }
  }

  return lines.slice(0, REPO_MAP_MAX_ENTRIES);
}

export async function readRepositorySummarySource(workspaceRoot: string): Promise<RepoSummarySource> {
  const [agentsContent, readmeContent] = await Promise.all([
    readOptionalWorkspaceFile(`${workspaceRoot}/AGENTS.md`),
    readOptionalWorkspaceFile(`${workspaceRoot}/README.md`),
  ]);

  return {
    agentsContent,
    readmeContent,
  };
}

export async function buildInitialRepoMapMarkdown(workspaceRoot: string): Promise<string> {
  const summarySource = await readRepositorySummarySource(workspaceRoot);
  const summaryLines = collectSeedSummaryLines(summarySource);
  const workspaceEntries = await collectWorkspaceSeedEntries(workspaceRoot);

  const lines = [
    "# Repository Map",
    "",
    "Bootstrap seed generated from repository docs and a bounded workspace scan.",
    "This file should stay concise and be enriched incrementally as Zace inspects specific files.",
    "",
    "## Repository Summary",
    ...(
      summaryLines.length > 0
        ? summaryLines.map((line) => `- ${line}`)
        : [
            "- Zace is a CLI coding agent built with Bun + TypeScript.",
            "- It runs as a planner-executor loop where side effects go through typed tools.",
          ]
    ),
    "",
    "## Seed Map",
    ...(
      workspaceEntries.length > 0
        ? workspaceEntries
        : ["- `.` - workspace layout not available during bootstrap."]
    ),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function buildIncrementalRepoMapEntry(pathValue: string, changedFiles: Set<string>): string {
  const normalizedPath = normalizeRelativePath(pathValue);
  const description = describeRepoPath(normalizedPath, false);

  if (changedFiles.has(normalizedPath)) {
    return `- \`${normalizedPath}\` - ${description}; updated during agent execution.`;
  }

  return `- \`${normalizedPath}\` - ${description}; inspected during agent execution.`;
}

export async function updateRepoMapWithTouchedFiles(input: {
  changedFiles: string[];
  touchedFiles: string[];
  workspaceRoot?: string;
}): Promise<string> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const existingContent = await readTextFile(paths.repoMapFile);
  const touchedFiles = Array.from(
    new Set(input.touchedFiles.map((pathValue) => normalizeRelativePath(pathValue)).filter(Boolean))
  ).sort((left, right) => left.localeCompare(right));
  if (touchedFiles.length === 0) {
    return existingContent;
  }

  const changedFileSet = new Set(
    input.changedFiles.map((pathValue) => normalizeRelativePath(pathValue))
  );
  const missingEntries = touchedFiles
    .filter((pathValue) => !existingContent.includes(`\`${pathValue}\``))
    .map((pathValue) => buildIncrementalRepoMapEntry(pathValue, changedFileSet));

  if (missingEntries.length === 0) {
    return existingContent;
  }

  const incrementalSectionHeader = "## Incremental Updates";
  const nextContent = existingContent.includes(incrementalSectionHeader)
    ? `${existingContent.trimEnd()}\n${missingEntries.join("\n")}\n`
    : `${existingContent.trimEnd()}\n\n${incrementalSectionHeader}\n${missingEntries.join("\n")}\n`;

  await fsWriteFile(paths.repoMapFile, nextContent, "utf8");
  return nextContent;
}

async function readTextFile(pathValue: string): Promise<string> {
  try {
    return await fsReadFile(pathValue, "utf8");
  } catch {
    return "";
  }
}
