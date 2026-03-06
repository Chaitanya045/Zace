import { join } from "node:path";

import type { BrainPaths } from "./paths";
import type { CurrentPlan, FileImportanceMap, WorkingMemory } from "./types";

import { fsReadFile, fsReaddir, fsStat } from "../tools/system/fs";
import { spawnProcess } from "../tools/system/process";
import { getBrainPaths, toWorkspaceRelativePath } from "./paths";
import {
  createInitialCurrentPlan,
  createInitialWorkingMemory,
  currentPlanSchema,
  fileImportanceSchema,
  memoryGraphEdgesSchema,
  memoryGraphNodesSchema,
  workingMemorySchema,
} from "./types";

const MEMORY_QUERY_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "and",
  "are",
  "code",
  "does",
  "file",
  "for",
  "from",
  "have",
  "help",
  "into",
  "just",
  "like",
  "make",
  "need",
  "please",
  "repo",
  "that",
  "the",
  "this",
  "what",
  "with",
]);

const RIPGREP_PATTERN_LIMIT = 12;
const RIPGREP_MATCH_LIMIT = 48;
const SNIPPET_CHAR_LIMIT = 280;
const IMPORTANT_FILE_LIMIT = 8;
const RECENT_EPISODIC_LOG_SEARCH_LIMIT = 24;
const RECENT_SUMMARY_SEARCH_LIMIT = 24;
const RETRIEVED_SNIPPET_LIMIT = 8;

type MemoryGraphFileContext = {
  importantFiles: FileImportanceMap;
  relevantFiles: string[];
  workspaceRoot: string;
};

type MemorySnippetSource = "episodic_log" | "graph_edge" | "graph_node" | "memory_markdown" | "summary";

type RankedMemorySnippet = {
  content: string;
  lineNumber?: number;
  score: number;
  sourcePath: string;
  sourceType: MemorySnippetSource;
};

type RipgrepMatch = {
  filePath: string;
  lineNumber: number;
  text: string;
};

export type ImportantFileEntry = {
  path: string;
  score: number;
};

export type MemorySearchInput = {
  currentPlan?: CurrentPlan;
  maxImportantFiles?: number;
  maxSnippets?: number;
  query: string;
  relevantFiles?: string[];
  workingMemory?: WorkingMemory;
  workspaceRoot?: string;
};

export type MemorySearchResult = {
  importantFiles: ImportantFileEntry[];
  keywords: string[];
  snippets: RankedMemorySnippet[];
};

function clipSnippet(content: string): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (normalized.length <= SNIPPET_CHAR_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, SNIPPET_CHAR_LIMIT - 16).trimEnd()}...[truncated]`;
}

function computeRecencyBonus(timestampMs: number | undefined): number {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
    return 0;
  }

  const ageMs = Math.max(0, Date.now() - timestampMs);
  if (ageMs <= 24 * 60 * 60 * 1000) {
    return 3;
  }
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) {
    return 2;
  }
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) {
    return 1;
  }

  return 0;
}

function escapeRipgrepPattern(keyword: string): string {
  return keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function extractMemorySearchKeywords(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_/-]+/u)
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length >= 3 && !MEMORY_QUERY_STOP_WORDS.has(keyword))
    )
  );
}

function findActivePlanStep(currentPlan: CurrentPlan | undefined): string | undefined {
  if (!currentPlan?.currentStepId) {
    return undefined;
  }

  return currentPlan.steps.find((step) => step.id === currentPlan.currentStepId)?.title;
}

function countKeywordMatches(text: string, keywords: string[]): number {
  const haystack = text.toLowerCase();
  return keywords.reduce(
    (count, keyword) => count + (haystack.includes(keyword.toLowerCase()) ? 1 : 0),
    0
  );
}

function pathMatchesContext(pathValue: string, candidates: string[]): boolean {
  const normalizedPath = pathValue.replace(/\\/gu, "/");
  return candidates.some((candidate) => {
    const normalizedCandidate = candidate.replace(/\\/gu, "/");
    return (
      normalizedCandidate === normalizedPath ||
      normalizedPath.endsWith(`/${normalizedCandidate}`) ||
      normalizedCandidate.endsWith(`/${normalizedPath}`)
    );
  });
}

function computeFileImportanceBonus(
  content: string,
  importantFiles: FileImportanceMap,
  sourcePath: string,
  workspaceRoot: string
): number {
  const relativeSourcePath = toWorkspaceRelativePath(workspaceRoot, sourcePath);
  let bestScore = importantFiles[relativeSourcePath] ?? 0;

  for (const [filePath, score] of Object.entries(importantFiles)) {
    if (content.includes(filePath) || relativeSourcePath === filePath) {
      bestScore = Math.max(bestScore, score);
    }
  }

  return bestScore * 5;
}

function buildGraphEdgeSnippet(
  edge: {
    from: string;
    to: string;
    type: string;
    updatedAt: null | string;
    weight: number;
  },
  input: {
    keywords: string[];
    paths: BrainPaths;
    relevantFiles: string[];
    workspaceRoot: string;
  }
): RankedMemorySnippet | undefined {
  const content = `Edge ${edge.from} -> ${edge.to} (${edge.type}, weight=${String(edge.weight)})`;
  const keywordMatches = countKeywordMatches(content, input.keywords);
  if (keywordMatches === 0 && !pathMatchesContext(content, input.relevantFiles)) {
    return undefined;
  }

  return {
    content,
    score:
      keywordMatches * 10 +
      2 +
      (pathMatchesContext(content, input.relevantFiles) ? 3 : 0) +
      computeRecencyBonus(edge.updatedAt ? Date.parse(edge.updatedAt) : undefined),
    sourcePath: toWorkspaceRelativePath(input.workspaceRoot, input.paths.edgesFile),
    sourceType: "graph_edge",
  };
}

function buildGraphNodeSnippet(
  node: {
    description?: string;
    filePath?: string;
    id: string;
    label: string;
    sessionId?: string;
    type: string;
    updatedAt: null | string;
  },
  input: MemoryGraphFileContext & {
    keywords: string[];
    paths: BrainPaths;
    relevantFiles: string[];
    workspaceRoot: string;
  }
): RankedMemorySnippet | undefined {
  const content = [
    `Node ${node.id} [${node.type}]`,
    node.label,
    node.description,
    node.filePath ? `file=${node.filePath}` : undefined,
    node.sessionId ? `session=${node.sessionId}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");
  const keywordMatches = countKeywordMatches(content, input.keywords);
  const graphProximity =
    (node.filePath && pathMatchesContext(node.filePath, input.relevantFiles)) ||
    pathMatchesContext(content, input.relevantFiles);
  if (keywordMatches === 0 && !graphProximity) {
    return undefined;
  }

  return {
    content,
    score:
      keywordMatches * 10 +
      3 +
      (graphProximity ? 4 : 0) +
      computeFileImportanceBonus(content, input.importantFiles, input.paths.nodesFile, input.workspaceRoot) +
      computeRecencyBonus(node.updatedAt ? Date.parse(node.updatedAt) : undefined),
    sourcePath: toWorkspaceRelativePath(input.workspaceRoot, input.paths.nodesFile),
    sourceType: "graph_node",
  };
}

async function collectMarkdownSearchFiles(paths: BrainPaths): Promise<Array<{
  filePath: string;
  sourceType: MemorySnippetSource;
}>> {
  const files: Array<{
    filePath: string;
    sourceType: MemorySnippetSource;
  }> = [
    {
      filePath: paths.decisionsFile,
      sourceType: "memory_markdown",
    },
    {
      filePath: paths.knowledgeFile,
      sourceType: "memory_markdown",
    },
    {
      filePath: paths.repoMapFile,
      sourceType: "memory_markdown",
    },
  ];

  for (const directoryEntry of await listMarkdownFiles(
    paths.sessionLogsDirectory,
    RECENT_EPISODIC_LOG_SEARCH_LIMIT
  )) {
    files.push({
      filePath: directoryEntry,
      sourceType: "episodic_log",
    });
  }

  for (const directoryEntry of await listMarkdownFiles(
    paths.summariesDirectory,
    RECENT_SUMMARY_SEARCH_LIMIT
  )) {
    files.push({
      filePath: directoryEntry,
      sourceType: "summary",
    });
  }

  return files;
}

async function listMarkdownFiles(
  directoryPath: string,
  limit = Number.POSITIVE_INFINITY
): Promise<string[]> {
  try {
    const entries = await fsReaddir(directoryPath, { withFileTypes: true });
    const nestedPaths = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          return await listMarkdownFiles(entryPath, limit);
        }

        return entry.name.endsWith(".md") ? [entryPath] : [];
      })
    );

    return nestedPaths
      .flat()
      .sort((left, right) => right.localeCompare(left))
      .slice(0, limit);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
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

async function readFileImportanceMap(paths: BrainPaths): Promise<FileImportanceMap> {
  return await parseJsonFile(
    paths.fileImportanceFile,
    (value) => fileImportanceSchema.safeParse(value),
    {}
  );
}

async function readImportantFiles(
  fileImportance: FileImportanceMap,
  input: {
    keywords: string[];
    maxImportantFiles: number;
    relevantFiles: string[];
  }
): Promise<ImportantFileEntry[]> {
  return Object.entries(fileImportance)
    .map(([pathValue, score]) => {
      const keywordBonus = countKeywordMatches(pathValue, input.keywords) > 0 ? 1 : 0;
      const relevantBonus = pathMatchesContext(pathValue, input.relevantFiles) ? 2 : 0;
      return {
        path: pathValue,
        ranking: score + keywordBonus + relevantBonus,
        score,
      };
    })
    .sort((left, right) => {
      if (right.ranking !== left.ranking) {
        return right.ranking - left.ranking;
      }

      return left.path.localeCompare(right.path);
    })
    .slice(0, input.maxImportantFiles)
    .map(({ path, score }) => ({ path, score }));
}

async function readWorkingMemory(paths: BrainPaths): Promise<WorkingMemory> {
  return await parseJsonFile(
    paths.workingMemoryFile,
    (value) => workingMemorySchema.safeParse(value),
    createInitialWorkingMemory()
  );
}

async function runRipgrepSearch(
  files: string[],
  keywords: string[]
): Promise<RipgrepMatch[] | undefined> {
  if (files.length === 0 || keywords.length === 0) {
    return [];
  }

  const args = [
    "--json",
    "-i",
    "-n",
    "--max-count",
    String(RIPGREP_MATCH_LIMIT),
    ...keywords
      .slice(0, RIPGREP_PATTERN_LIMIT)
      .flatMap((keyword) => ["-e", escapeRipgrepPattern(keyword)]),
    ...files,
  ];

  const childProcess = spawnProcess("rg", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<RipgrepMatch[] | undefined>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    childProcess.stdout?.setEncoding("utf8");
    childProcess.stderr?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    childProcess.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    childProcess.on("error", (error) => {
      if ("code" in error && error.code === "ENOENT") {
        resolve(undefined);
        return;
      }

      reject(error);
    });
    childProcess.on("close", (exitCode) => {
      if (exitCode === 1) {
        resolve([]);
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`ripgrep failed: ${stderr.trim() || `exit code ${String(exitCode)}`}`));
        return;
      }

      const matches: RipgrepMatch[] = [];
      for (const line of stdout.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "match") {
          continue;
        }

        const matchData = parsed as {
          data?: {
            line_number?: number;
            lines?: { text?: string };
            path?: { text?: string };
          };
        };
        const filePath = matchData.data?.path?.text;
        const text = matchData.data?.lines?.text;
        const lineNumber = matchData.data?.line_number;
        if (!filePath || !text || typeof lineNumber !== "number") {
          continue;
        }

        matches.push({
          filePath,
          lineNumber,
          text,
        });
      }

      resolve(matches);
    });
  });
}

async function scanFilesWithoutRipgrep(
  files: Array<{
    filePath: string;
    sourceType: MemorySnippetSource;
  }>,
  keywords: string[]
): Promise<RipgrepMatch[]> {
  const matches: RipgrepMatch[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await fsReadFile(file.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }

    const lines = content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (countKeywordMatches(line, keywords) === 0) {
        return;
      }

      matches.push({
        filePath: file.filePath,
        lineNumber: index + 1,
        text: line,
      });
    });
  }

  return matches;
}

async function statTimestamp(pathValue: string): Promise<number | undefined> {
  try {
    const fileStat = await fsStat(pathValue);
    return fileStat.mtimeMs;
  } catch {
    return undefined;
  }
}

async function searchMarkdownMemories(
  paths: BrainPaths,
  input: {
    importantFiles: FileImportanceMap;
    keywords: string[];
    maxSnippets: number;
    relevantFiles: string[];
    workspaceRoot: string;
  }
): Promise<RankedMemorySnippet[]> {
  const markdownFiles = await collectMarkdownSearchFiles(paths);
  const filePaths = markdownFiles.map((entry) => entry.filePath);
  const ripgrepMatches = await runRipgrepSearch(filePaths, input.keywords);
  const matches = ripgrepMatches ?? await scanFilesWithoutRipgrep(markdownFiles, input.keywords);
  const sourceTypeByPath = new Map(markdownFiles.map((entry) => [entry.filePath, entry.sourceType]));
  const seenMatchKeys = new Set<string>();
  const timestampCache = new Map<string, Promise<number | undefined>>();
  const getCachedTimestamp = (filePath: string): Promise<number | undefined> => {
    const existing = timestampCache.get(filePath);
    if (existing) {
      return existing;
    }

    const pending = statTimestamp(filePath);
    timestampCache.set(filePath, pending);
    return pending;
  };
  const snippets = await Promise.all(
    matches.map(async (match) => {
      const matchKey = `${match.filePath}:${String(match.lineNumber)}`;
      if (seenMatchKeys.has(matchKey)) {
        return undefined;
      }
      seenMatchKeys.add(matchKey);

      const relativeSourcePath = toWorkspaceRelativePath(input.workspaceRoot, match.filePath);
      const keywordMatches = countKeywordMatches(match.text, input.keywords);
      return {
        content: clipSnippet(match.text),
        lineNumber: match.lineNumber,
        score:
          keywordMatches * 10 +
          computeRecencyBonus(await getCachedTimestamp(match.filePath)) +
          (pathMatchesContext(relativeSourcePath, input.relevantFiles) ? 2 : 0) +
          computeFileImportanceBonus(match.text, input.importantFiles, match.filePath, input.workspaceRoot),
        sourcePath: relativeSourcePath,
        sourceType: sourceTypeByPath.get(match.filePath) ?? "memory_markdown",
      } satisfies RankedMemorySnippet;
    })
  );

  return snippets
    .filter((snippet): snippet is RankedMemorySnippet => Boolean(snippet))
    .sort((left, right) => right.score - left.score)
    .slice(0, input.maxSnippets);
}

async function searchGraphMemories(
  paths: BrainPaths,
  input: {
    importantFiles: FileImportanceMap;
    keywords: string[];
    maxSnippets: number;
    relevantFiles: string[];
    workspaceRoot: string;
  }
): Promise<RankedMemorySnippet[]> {
  const [nodes, edges] = await Promise.all([
    parseJsonFile(paths.nodesFile, (value) => memoryGraphNodesSchema.safeParse(value), []),
    parseJsonFile(paths.edgesFile, (value) => memoryGraphEdgesSchema.safeParse(value), []),
  ]);

  const nodeSnippets = nodes
    .map((node) =>
      buildGraphNodeSnippet(node, {
        importantFiles: input.importantFiles,
        keywords: input.keywords,
        paths,
        relevantFiles: input.relevantFiles,
        workspaceRoot: input.workspaceRoot,
      })
    )
    .filter((snippet): snippet is RankedMemorySnippet => Boolean(snippet));
  const edgeSnippets = edges
    .map((edge) =>
      buildGraphEdgeSnippet(edge, {
        keywords: input.keywords,
        paths,
        relevantFiles: input.relevantFiles,
        workspaceRoot: input.workspaceRoot,
      })
    )
    .filter((snippet): snippet is RankedMemorySnippet => Boolean(snippet));

  return [...nodeSnippets, ...edgeSnippets]
    .sort((left, right) => right.score - left.score)
    .slice(0, input.maxSnippets);
}

export async function searchMemory(input: MemorySearchInput): Promise<MemorySearchResult> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const workingMemory = input.workingMemory ?? await readWorkingMemory(paths);
  const currentPlan = input.currentPlan ?? await parseJsonFile(
    paths.currentPlanFile,
    (value) => currentPlanSchema.safeParse(value),
    createInitialCurrentPlan()
  );
  const activePlanStep = findActivePlanStep(currentPlan);
  const relevantFiles = Array.from(
    new Set([
      ...(input.relevantFiles ?? []),
      ...workingMemory.relevantFiles,
      ...currentPlan.steps.flatMap((step) => step.relevantFiles),
    ])
  );
  const keywords = extractMemorySearchKeywords([
    input.query,
    workingMemory.goal ?? "",
    workingMemory.currentStep ?? "",
    activePlanStep ?? "",
    relevantFiles.join(" "),
  ].join(" "));
  const maxImportantFiles = Math.max(1, input.maxImportantFiles ?? IMPORTANT_FILE_LIMIT);
  const maxSnippets = Math.max(1, input.maxSnippets ?? RETRIEVED_SNIPPET_LIMIT);
  const fileImportance = await readFileImportanceMap(paths);
  const importantFiles = await readImportantFiles(fileImportance, {
    keywords,
    maxImportantFiles,
    relevantFiles,
  });

  const [markdownSnippets, graphSnippets] = await Promise.all([
    searchMarkdownMemories(paths, {
      importantFiles: fileImportance,
      keywords,
      maxSnippets,
      relevantFiles,
      workspaceRoot,
    }),
    searchGraphMemories(paths, {
      importantFiles: fileImportance,
      keywords,
      maxSnippets,
      relevantFiles,
      workspaceRoot,
    }),
  ]);

  const snippets = [...markdownSnippets, ...graphSnippets]
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSnippets);

  return {
    importantFiles,
    keywords,
    snippets,
  };
}
