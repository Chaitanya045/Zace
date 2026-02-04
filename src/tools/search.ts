import { z } from "zod";

import type { Tool, ToolResult } from "../types/tool";

import { ToolExecutionError } from "../utils/errors";
import { logToolCall, logToolResult } from "../utils/logger";

const searchInFilesSchema = z.object({
  caseSensitive: z.boolean().default(false),
  filePattern: z.string().optional(),
  maxResults: z.number().int().positive().default(50),
  path: z.string().default("."),
  pattern: z.string().min(1),
});

const findFilesSchema = z.object({
  maxDepth: z.number().int().positive().optional(),
  path: z.string().default("."),
  pattern: z.string().min(1),
});

async function searchInFiles(args: unknown): Promise<ToolResult> {
  try {
    const { caseSensitive, filePattern, maxResults, path, pattern } =
      searchInFilesSchema.parse(args);
    logToolCall("search_in_files", { caseSensitive, filePattern, maxResults, path, pattern });

    // Build grep command with options
    let grepCmd = `grep -r -n ${caseSensitive ? "" : "-i"} -H`;

    // Add file pattern if specified
    if (filePattern) {
      grepCmd += ` --include="${filePattern}"`;
    }

    // Add pattern and path
    grepCmd += ` "${pattern}" ${path}`;

    // Limit results
    grepCmd += ` | head -n ${maxResults}`;

    const result = await Bun.$`sh -c ${grepCmd}`.quiet();

    const output = result.stdout.toString();

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      // Exit code 1 means no matches, which is not an error
      const errorOutput = result.stderr.toString();
      logToolResult({ output: errorOutput, success: false });
      return {
        error: `Search failed: ${errorOutput}`,
        output: "",
        success: false,
      };
    }

    const matchCount = output ? output.trim().split("\n").length : 0;
    logToolResult({ output: `Found ${matchCount} matches`, success: true });

    return {
      output: output || "No matches found",
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to search in files: ${message}`, error);
  }
}

async function findFiles(args: unknown): Promise<ToolResult> {
  try {
    const { maxDepth, path, pattern } = findFilesSchema.parse(args);
    logToolCall("find_files", { maxDepth, path, pattern });

    // Build find command
    let findCmd = `find ${path} -type f`;

    if (maxDepth) {
      findCmd += ` -maxdepth ${maxDepth}`;
    }

    findCmd += ` -name "${pattern}"`;

    const result = await Bun.$`sh -c ${findCmd}`.quiet();

    const output = result.stdout.toString();

    if (result.exitCode !== 0) {
      const errorOutput = result.stderr.toString();
      logToolResult({ output: errorOutput, success: false });
      return {
        error: `Find failed: ${errorOutput}`,
        output: "",
        success: false,
      };
    }

    const fileCount = output ? output.trim().split("\n").filter((line) => line).length : 0;
    logToolResult({ output: `Found ${fileCount} files`, success: true });

    return {
      output: output || "No files found",
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to find files: ${message}`, error);
  }
}

export const searchTools: Tool[] = [
  {
    description:
      "Search for text pattern in files. Returns file paths and line numbers with matches.",
    execute: searchInFiles,
    name: "search_in_files",
    parameters: searchInFilesSchema,
  },
  {
    description: "Find files by name pattern (supports wildcards like *.ts, test*.js)",
    execute: findFiles,
    name: "find_files",
    parameters: findFilesSchema,
  },
];
