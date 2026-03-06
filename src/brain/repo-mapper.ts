import { fsReaddir, fsReadFile, fsStat, fsWriteFile } from "../tools/system/fs";
import { getBrainPaths } from "./paths";

type RepoSummarySource = {
  agentsContent?: string;
  readmeContent?: string;
};

const REPO_MAP_PATH_DESCRIPTIONS = new Map<string, string>([
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
  const srcDirectoryPath = `${workspaceRoot}/src`;
  const srcEntries = await listTopLevelSourceEntries(srcDirectoryPath);

  const lines = [
    "# Repository Map",
    "",
    "Bootstrap seed generated from repository docs and the current top-level source layout.",
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
      srcEntries.length > 0
        ? srcEntries
        : ["- `src/` - source tree not available during bootstrap."]
    ),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function buildIncrementalRepoMapEntry(pathValue: string, changedFiles: Set<string>): string {
  if (changedFiles.has(pathValue)) {
    return `- \`${pathValue}\` - updated during agent execution.`;
  }

  if (pathValue.startsWith("tests/")) {
    return `- \`${pathValue}\` - inspected test coverage during agent execution.`;
  }

  return `- \`${pathValue}\` - inspected during agent execution.`;
}

export async function updateRepoMapWithTouchedFiles(input: {
  changedFiles: string[];
  touchedFiles: string[];
  workspaceRoot?: string;
}): Promise<string> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const existingContent = await readTextFile(paths.repoMapFile);
  const touchedFiles = Array.from(new Set(input.touchedFiles.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );
  if (touchedFiles.length === 0) {
    return existingContent;
  }

  const changedFileSet = new Set(input.changedFiles);
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

async function listTopLevelSourceEntries(srcDirectoryPath: string): Promise<string[]> {
  if (!(await pathExists(srcDirectoryPath))) {
    return [];
  }

  const entries = await fsReaddir(srcDirectoryPath, { withFileTypes: true });
  return entries
    .map((entry) => {
      const relativePath = entry.isDirectory()
        ? `src/${entry.name}`
        : `src/${entry.name}`;
      const description =
        REPO_MAP_PATH_DESCRIPTIONS.get(relativePath) ??
        (entry.isDirectory() ? "workspace source area" : "workspace source file");
      const renderedPath = entry.isDirectory() ? `${relativePath}/` : relativePath;
      return {
        description,
        renderedPath,
      };
    })
    .sort((left, right) => left.renderedPath.localeCompare(right.renderedPath))
    .map((entry) => `- \`${entry.renderedPath}\` - ${entry.description}`);
}

async function readTextFile(pathValue: string): Promise<string> {
  try {
    return await fsReadFile(pathValue, "utf8");
  } catch {
    return "";
  }
}
