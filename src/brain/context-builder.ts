import type { LlmMessage } from "../llm/types";
import type { BrainPaths } from "./paths";
import type { CurrentPlan, WorkingMemory } from "./types";

import { fsReadFile } from "../tools/system/fs";
import { searchMemory, type ImportantFileEntry, type MemorySearchResult } from "./memory-retriever";
import { getBrainPaths } from "./paths";
import {
  createInitialCurrentPlan,
  createInitialWorkingMemory,
  currentPlanSchema,
  workingMemorySchema,
} from "./types";

export type BrainContextFileDescriptor = {
  alwaysLoad: boolean;
  label: string;
  path: string;
};

export type BrainContextBuildInput = {
  callKind: "executor" | "planner";
  maxImportantFiles?: number;
  maxRetrievedSnippets?: number;
  query: string;
  relevantFiles?: string[];
  workspaceRoot?: string;
};

export type BrainContextBuildResult = {
  currentPlan: CurrentPlan;
  importantFiles: ImportantFileEntry[];
  keywords: string[];
  message: LlmMessage;
  retrievedSnippets: MemorySearchResult["snippets"];
  workingMemory: WorkingMemory;
};

export function getCoreBrainContextFiles(paths: BrainPaths): BrainContextFileDescriptor[] {
  return [
    {
      alwaysLoad: true,
      label: "identity",
      path: paths.identityFile,
    },
    {
      alwaysLoad: true,
      label: "working_memory",
      path: paths.workingMemoryFile,
    },
    {
      alwaysLoad: true,
      label: "current_plan",
      path: paths.currentPlanFile,
    },
  ];
}

export function injectSystemContextMessage(messages: LlmMessage[], content: string): LlmMessage[] {
  const systemMessage: LlmMessage = {
    content,
    role: "system",
  };
  const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystemIndex < 0) {
    return [...messages, systemMessage];
  }

  return [
    ...messages.slice(0, firstNonSystemIndex),
    systemMessage,
    ...messages.slice(firstNonSystemIndex),
  ];
}

async function parseJsonFile<T>(
  pathValue: string,
  safeParse: (value: unknown) => {
    data?: T;
    success: boolean;
  },
  fallback: T
): Promise<T> {
  try {
    const content = await fsReadFile(pathValue, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const validated = safeParse(parsed);
    return validated.success && validated.data !== undefined ? validated.data : fallback;
  } catch {
    return fallback;
  }
}

function formatImportantFiles(importantFiles: ImportantFileEntry[]): string {
  if (importantFiles.length === 0) {
    return "- none recorded";
  }

  return importantFiles
    .map((entry) => `- ${entry.path} (score=${entry.score.toFixed(2)})`)
    .join("\n");
}

function formatRetrievedSnippets(snippets: MemorySearchResult["snippets"]): string {
  if (snippets.length === 0) {
    return "- none matched";
  }

  return snippets
    .map((snippet, index) => {
      const location = snippet.lineNumber
        ? `${snippet.sourcePath}:${String(snippet.lineNumber)}`
        : snippet.sourcePath;
      return `${String(index + 1)}. [${snippet.sourceType}] ${location} (score=${snippet.score.toFixed(2)})\n   ${snippet.content}`;
    })
    .join("\n");
}

function formatKeywords(keywords: string[]): string {
  return keywords.length > 0 ? keywords.join(", ") : "none";
}

async function readTextFile(pathValue: string): Promise<string> {
  try {
    return await fsReadFile(pathValue, "utf8");
  } catch {
    return "";
  }
}

export async function buildBrainContextMessage(
  input: BrainContextBuildInput
): Promise<BrainContextBuildResult> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const [identity, workingMemory, currentPlan] = await Promise.all([
    readTextFile(paths.identityFile),
    parseJsonFile(
      paths.workingMemoryFile,
      (value) => workingMemorySchema.safeParse(value),
      createInitialWorkingMemory()
    ),
    parseJsonFile(
      paths.currentPlanFile,
      (value) => currentPlanSchema.safeParse(value),
      createInitialCurrentPlan()
    ),
  ]);
  const memorySearch = await searchMemory({
    currentPlan,
    maxImportantFiles: input.maxImportantFiles,
    maxSnippets: input.maxRetrievedSnippets,
    query: input.query,
    relevantFiles: input.relevantFiles,
    workingMemory,
    workspaceRoot,
  });
  const content = [
    `PERSISTENT BRAIN CONTEXT (${input.callKind.toUpperCase()})`,
    "",
    "Use this as supporting repository memory. Direct user instructions and current tool state still take priority.",
    "",
    "[identity]",
    identity.trim() || "(empty)",
    "",
    "[working_memory]",
    JSON.stringify(workingMemory, null, 2),
    "",
    "[current_plan]",
    JSON.stringify(currentPlan, null, 2),
    "",
    "[retrieved_memory_keywords]",
    formatKeywords(memorySearch.keywords),
    "",
    "[retrieved_memories]",
    formatRetrievedSnippets(memorySearch.snippets),
    "",
    "[important_files]",
    formatImportantFiles(memorySearch.importantFiles),
  ].join("\n");

  return {
    currentPlan,
    importantFiles: memorySearch.importantFiles,
    keywords: memorySearch.keywords,
    message: {
      content,
      role: "system",
    },
    retrievedSnippets: memorySearch.snippets,
    workingMemory,
  };
}
