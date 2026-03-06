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
};

type WorkspaceEntry = {
  isDirectory: boolean;
  name: string;
};

const ROOT_FILE_PRIORITIES = new Map<string, number>([
  ["AGENTS.md", 1],
  ["CLAUDE.md", 2],
  ["README.md", 3],
  ["package.json", 4],
  ["pyproject.toml", 5],
  ["Cargo.toml", 6],
  ["go.mod", 7],
  ["tsconfig.json", 8],
  ["Makefile", 9],
  ["Dockerfile", 10],
  [".env.example", 11],
]);

const ROOT_DIRECTORY_PRIORITIES = new Map<string, number>([
  ["src", 20],
  ["lib", 21],
  ["app", 22],
  ["apps", 23],
  ["packages", 24],
  ["pkg", 25],
  ["internal", 26],
  ["cmd", 27],
  ["services", 28],
  ["service", 29],
  ["server", 30],
  ["client", 31],
  ["web", 32],
  ["frontend", 33],
  ["backend", 34],
  ["ui", 35],
  ["docs", 36],
  ["doc", 37],
  ["scripts", 38],
  ["tools", 39],
  ["tests", 40],
  ["test", 41],
  ["spec", 42],
  ["e2e", 43],
  ["integration", 44],
  ["python", 45],
  ["db", 46],
  ["database", 47],
  ["migrations", 48],
]);

const AUTOMATION_DIRECTORY_NAMES = new Set(["script", "scripts", "tool", "tools"]);
const BACKEND_DIRECTORY_NAMES = new Set(["api", "backend", "server", "service", "services"]);
const CONFIGURATION_DIRECTORY_NAMES = new Set([".github", ".vscode", "config", "configs"]);
const DATABASE_DIRECTORY_NAMES = new Set(["data", "database", "db", "migration", "migrations", "schema", "schemas", "sql"]);
const DOCUMENTATION_DIRECTORY_NAMES = new Set(["doc", "docs", "documentation"]);
const FRONTEND_DIRECTORY_NAMES = new Set(["client", "frontend", "ui", "web"]);
const SOURCE_DIRECTORY_NAMES = new Set([
  "app",
  "apps",
  "cmd",
  "examples",
  "internal",
  "lib",
  "module",
  "modules",
  "package",
  "packages",
  "pkg",
  "python",
  "src",
]);
const TEST_DIRECTORY_NAMES = new Set([
  "__tests__",
  "e2e",
  "fixture",
  "fixtures",
  "integration",
  "spec",
  "specs",
  "test",
  "tests",
]);

const CONFIGURATION_FILE_NAMES = new Map<string, string>([
  [".env.example", "example runtime environment configuration"],
  ["AGENTS.md", "repository operating instructions for coding agents"],
  ["Cargo.toml", "Rust project manifest"],
  ["CLAUDE.md", "repository operating instructions for AI agents"],
  ["Dockerfile", "container build definition"],
  ["go.mod", "Go module definition"],
  ["Makefile", "task automation file"],
  ["README.md", "repository overview and usage notes"],
  ["package.json", "Node or Bun package manifest and scripts"],
  ["pyproject.toml", "Python project manifest"],
  ["tsconfig.json", "TypeScript compiler configuration"],
]);

const INTERESTING_FILE_EXTENSIONS = new Set([
  ".adoc",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".rst",
  ".sh",
  ".sql",
  ".toml",
  ".tsx",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

const REPO_MAP_MAX_DEPTH = 2;
const REPO_MAP_MAX_ENTRIES = 48;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".pnpm-store",
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
const SUMMARY_HINT_PATTERN = /\b(api|application|architecture|backend|built|cache|cli|contains|database|deploy|engine|framework|frontend|implements|library|model|module|monorepo|pipeline|platform|project|provides|queue|repository|runtime|schema|service|stack|storage|test|testing|tool|uses|worker|workspace)\b/iu;

function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/gu, "/").replace(/^\.\/+/, "");
}

function getLowercasePathSegments(pathValue: string): string[] {
  return normalizeRelativePath(pathValue)
    .replace(/\/$/u, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function getFileExtension(pathValue: string): string {
  const normalizedPath = normalizeRelativePath(pathValue);
  const extensionIndex = normalizedPath.lastIndexOf(".");
  if (extensionIndex < 0) {
    return "";
  }

  return normalizedPath.slice(extensionIndex).toLowerCase();
}

function isLikelyManifestFile(name: string): boolean {
  return CONFIGURATION_FILE_NAMES.has(name);
}

function isInterestingRootFile(name: string): boolean {
  return (
    ROOT_FILE_PRIORITIES.has(name) ||
    INTERESTING_FILE_EXTENSIONS.has(getFileExtension(name))
  );
}

function isInterestingNestedFile(relativePath: string): boolean {
  return INTERESTING_FILE_EXTENSIONS.has(getFileExtension(relativePath));
}

function normalizeSummaryLine(line: string): string {
  return line
    .replace(/^#+\s*/u, "")
    .replace(/^[-*]\s*/u, "")
    .replace(/`/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isSummaryCandidate(line: string): boolean {
  if (line.length < 20 || line.length > 180) {
    return false;
  }
  if (line === "---" || line === "***" || line.startsWith("```")) {
    return false;
  }
  if (/^[A-Z][A-Za-z0-9 _-]+:$/u.test(line)) {
    return false;
  }

  return SUMMARY_HINT_PATTERN.test(line) || line.startsWith("- ");
}

function collectSummaryLinesFromDocument(content: string | undefined): string[] {
  if (!content) {
    return [];
  }

  const normalizedLines = content
    .split(/\r?\n/u)
    .map((line) => normalizeSummaryLine(line))
    .filter(Boolean);
  const summaryCandidates = normalizedLines.filter((line) => isSummaryCandidate(line));
  const linesToUse = summaryCandidates.length > 0 ? summaryCandidates : normalizedLines;

  return Array.from(new Set(linesToUse)).slice(0, 5);
}

function buildWorkspaceFactLines(rootEntries: WorkspaceEntry[]): string[] {
  const manifestNames = rootEntries
    .filter((entry) => !entry.isDirectory && isLikelyManifestFile(entry.name))
    .map((entry) => `\`${entry.name}\``)
    .slice(0, 4);
  const primaryAreas = rootEntries
    .filter((entry) => entry.isDirectory && !shouldSkipDirectory(entry.name))
    .slice(0, 5)
    .map((entry) => `\`${entry.name}/\``);
  const lines: string[] = [];

  if (manifestNames.length > 0) {
    lines.push(`Detected root manifests: ${manifestNames.join(", ")}.`);
  }
  if (primaryAreas.length > 0) {
    lines.push(`Primary workspace areas: ${primaryAreas.join(", ")}.`);
  }

  return lines;
}

function scoreEntryPriority(name: string, isDirectory: boolean, depth: number): number {
  if (depth > 0) {
    if (isDirectory) {
      return ROOT_DIRECTORY_PRIORITIES.get(name.toLowerCase()) ?? 999;
    }

    return ROOT_FILE_PRIORITIES.get(name) ?? 999;
  }

  if (isDirectory) {
    return ROOT_DIRECTORY_PRIORITIES.get(name.toLowerCase()) ?? 200;
  }

  return ROOT_FILE_PRIORITIES.get(name) ?? 400;
}

function shouldSkipDirectory(name: string): boolean {
  return SKIPPED_DIRECTORY_NAMES.has(name);
}

function isHiddenDirectory(name: string): boolean {
  return name.startsWith(".") && !CONFIGURATION_DIRECTORY_NAMES.has(name);
}

function shouldIncludeSeedEntry(relativePath: string, isDirectory: boolean, depth: number): boolean {
  if (depth === 0) {
    return isDirectory || isInterestingRootFile(relativePath);
  }

  if (isDirectory) {
    return depth <= REPO_MAP_MAX_DEPTH;
  }

  return isInterestingNestedFile(relativePath);
}

function shouldDescendInto(relativePath: string, depth: number): boolean {
  if (depth >= REPO_MAP_MAX_DEPTH) {
    return false;
  }

  const directoryName = getLowercasePathSegments(relativePath).at(-1);
  if (!directoryName) {
    return false;
  }

  return !isHiddenDirectory(directoryName);
}

function hasAnyPathSegment(pathValue: string, names: Set<string>): boolean {
  return getLowercasePathSegments(pathValue).some((segment) => names.has(segment));
}

function describeFilePath(pathValue: string): string {
  const normalizedPath = normalizeRelativePath(pathValue);
  const fileName = normalizedPath.split("/").at(-1) ?? normalizedPath;
  const exactDescription = CONFIGURATION_FILE_NAMES.get(fileName);
  if (exactDescription) {
    return exactDescription;
  }

  const extension = getFileExtension(normalizedPath);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(extension)) {
    return "JavaScript or TypeScript source file";
  }
  if (extension === ".py") {
    return "Python source file";
  }
  if (extension === ".go") {
    return "Go source file";
  }
  if (extension === ".rs") {
    return "Rust source file";
  }
  if ([".java", ".kt", ".kts", ".cs", ".php", ".rb", ".c", ".cc", ".cpp", ".h", ".hpp"].includes(extension)) {
    return "application source file";
  }
  if ([".json", ".yaml", ".yml", ".toml", ".ini"].includes(extension)) {
    return "configuration or metadata file";
  }
  if ([".md", ".rst", ".adoc", ".txt"].includes(extension)) {
    return "documentation or project note";
  }
  if (extension === ".sql") {
    return "database schema or query file";
  }
  if (extension === ".sh") {
    return "shell automation script";
  }

  if (hasAnyPathSegment(normalizedPath, TEST_DIRECTORY_NAMES)) {
    return "test file or fixture";
  }
  if (hasAnyPathSegment(normalizedPath, DOCUMENTATION_DIRECTORY_NAMES)) {
    return "documentation file";
  }

  return "workspace file";
}

function describeDirectoryPath(pathValue: string): string {
  const normalizedPath = normalizeRelativePath(pathValue).replace(/\/$/u, "");
  const segments = getLowercasePathSegments(normalizedPath);
  const directoryName = segments.at(-1) ?? normalizedPath.toLowerCase();

  if (TEST_DIRECTORY_NAMES.has(directoryName) || hasAnyPathSegment(normalizedPath, TEST_DIRECTORY_NAMES)) {
    return segments.length <= 1 ? "test or fixture area" : "test suite or fixture area";
  }
  if (DOCUMENTATION_DIRECTORY_NAMES.has(directoryName) || hasAnyPathSegment(normalizedPath, DOCUMENTATION_DIRECTORY_NAMES)) {
    return "documentation area";
  }
  if (AUTOMATION_DIRECTORY_NAMES.has(directoryName) || hasAnyPathSegment(normalizedPath, AUTOMATION_DIRECTORY_NAMES)) {
    return "automation or tooling area";
  }
  if (CONFIGURATION_DIRECTORY_NAMES.has(directoryName) || hasAnyPathSegment(normalizedPath, CONFIGURATION_DIRECTORY_NAMES)) {
    return "configuration or integration area";
  }
  if (DATABASE_DIRECTORY_NAMES.has(directoryName) || hasAnyPathSegment(normalizedPath, DATABASE_DIRECTORY_NAMES)) {
    return "database or migration area";
  }
  if (FRONTEND_DIRECTORY_NAMES.has(directoryName) || hasAnyPathSegment(normalizedPath, FRONTEND_DIRECTORY_NAMES)) {
    return segments.length <= 1 ? "frontend or client area" : "frontend or client module area";
  }
  if (BACKEND_DIRECTORY_NAMES.has(directoryName) || hasAnyPathSegment(normalizedPath, BACKEND_DIRECTORY_NAMES)) {
    return segments.length <= 1 ? "backend or service area" : "backend or service module area";
  }
  if (directoryName === "python") {
    return "Python source area";
  }
  if (SOURCE_DIRECTORY_NAMES.has(directoryName) || hasAnyPathSegment(normalizedPath, SOURCE_DIRECTORY_NAMES)) {
    return segments.length <= 1 ? "primary source area" : "source module area";
  }

  return "workspace area";
}

function describeRepoPath(pathValue: string, isDirectory: boolean): string {
  return isDirectory ? describeDirectoryPath(pathValue) : describeFilePath(pathValue);
}

function formatRepoMapEntry(relativePath: string, isDirectory: boolean): string {
  const renderedPath = isDirectory ? `${relativePath}/` : relativePath;
  return `- \`${renderedPath}\` - ${describeRepoPath(relativePath, isDirectory)}`;
}

function sortDirectoryEntries(entries: WorkspaceEntry[], depth: number): WorkspaceEntry[] {
  return [...entries].sort((left, right) => {
    const leftPriority = scoreEntryPriority(left.name, left.isDirectory, depth);
    const rightPriority = scoreEntryPriority(right.name, right.isDirectory, depth);
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

async function readDirectoryEntries(directoryPath: string): Promise<WorkspaceEntry[]> {
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

async function readWorkspaceRootEntries(workspaceRoot: string): Promise<WorkspaceEntry[]> {
  return sortDirectoryEntries(await readDirectoryEntries(workspaceRoot), 0);
}

async function collectWorkspaceSeedEntries(workspaceRoot: string): Promise<string[]> {
  const rootEntries = await readWorkspaceRootEntries(workspaceRoot);
  const lines: string[] = [];
  const seenPaths = new Set<string>();
  const queue: SeedQueueItem[] = [];

  for (const entry of rootEntries) {
    if (entry.isDirectory && (shouldSkipDirectory(entry.name) || isHiddenDirectory(entry.name))) {
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
      if (entry.isDirectory && (shouldSkipDirectory(entry.name) || isHiddenDirectory(entry.name))) {
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
        });
      }

      if (lines.length >= REPO_MAP_MAX_ENTRIES) {
        break;
      }
    }
  }

  return lines.slice(0, REPO_MAP_MAX_ENTRIES);
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

export async function buildBootstrapRepositorySummaryLines(
  workspaceRoot: string,
  summarySource?: RepoSummarySource
): Promise<string[]> {
  const resolvedSummarySource = summarySource ?? await readRepositorySummarySource(workspaceRoot);
  const rootEntries = await readWorkspaceRootEntries(workspaceRoot);
  const documentLines = Array.from(new Set([
    ...collectSummaryLinesFromDocument(resolvedSummarySource.agentsContent),
    ...collectSummaryLinesFromDocument(resolvedSummarySource.readmeContent),
  ])).slice(0, 5);

  if (documentLines.length >= 3) {
    return documentLines;
  }

  return Array.from(new Set([
    ...documentLines,
    ...buildWorkspaceFactLines(rootEntries),
  ])).slice(0, 5);
}

export async function buildInitialRepoMapMarkdown(workspaceRoot: string): Promise<string> {
  const summarySource = await readRepositorySummarySource(workspaceRoot);
  const summaryLines = await buildBootstrapRepositorySummaryLines(workspaceRoot, summarySource);
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
            "- Repository summary unavailable during bootstrap.",
            "- This map reflects only the detected workspace layout.",
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
