import { z } from "zod";

import type { Tool, ToolResult } from "../types/tool";

import { ToolExecutionError } from "../utils/errors";
import { logToolCall, logToolResult } from "../utils/logger";

const gitStatusSchema = z.object({});

const gitDiffSchema = z.object({
  staged: z.boolean().default(false),
});

async function gitStatus(args: unknown): Promise<ToolResult> {
  try {
    gitStatusSchema.parse(args);
    logToolCall("git_status", {});

    const result = await Bun.$`git status --porcelain`.quiet();

    if (result.exitCode !== 0) {
      return {
        error: "Not a git repository or git command failed",
        output: "",
        success: false,
      };
    }

    const output = result.stdout.toString();
    logToolResult({ output: "Retrieved git status", success: true });

    return {
      output: output || "Working directory clean",
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to get git status: ${message}`, error);
  }
}

async function gitDiff(args: unknown): Promise<ToolResult> {
  try {
    const { staged } = gitDiffSchema.parse(args);
    logToolCall("git_diff", { staged });

    const command = staged ? Bun.$`git diff --cached` : Bun.$`git diff`;
    const result = await command.quiet();

    if (result.exitCode !== 0) {
      return {
        error: "Git diff command failed",
        output: "",
        success: false,
      };
    }

    const output = result.stdout.toString();
    logToolResult({ output: `Retrieved ${staged ? "staged" : "unstaged"} diff`, success: true });

    return {
      output: output || "No changes",
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to get git diff: ${message}`, error);
  }
}

export const gitTools: Tool[] = [
  {
    description: "Get the current git repository status",
    execute: gitStatus,
    name: "git_status",
    parameters: gitStatusSchema,
  },
  {
    description: "Get git diff (staged or unstaged changes)",
    execute: gitDiff,
    name: "git_diff",
    parameters: gitDiffSchema,
  },
];
