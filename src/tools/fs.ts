import { z } from "zod";

import type { Tool, ToolResult } from "../types/tool";

import { ToolExecutionError } from "../utils/errors";
import { logToolCall, logToolResult } from "../utils/logger";

const readFileSchema = z.object({
  path: z.string().min(1),
});

const writeFileSchema = z.object({
  content: z.string(),
  path: z.string().min(1),
});

const listDirectorySchema = z.object({
  path: z.string().min(1),
});

async function readFile(args: unknown): Promise<ToolResult> {
  try {
    const { path } = readFileSchema.parse(args);
    logToolCall("read_file", { path });

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return {
        error: `File not found: ${path}`,
        output: "",
        success: false,
      };
    }

    const content = await file.text();
    logToolResult({ output: `Read ${content.length} bytes`, success: true });

    return {
      output: content,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to read file: ${message}`, error);
  }
}

async function writeFile(args: unknown): Promise<ToolResult> {
  try {
    const { content, path } = writeFileSchema.parse(args);
    logToolCall("write_file", { contentLength: content.length, path });

    await Bun.write(path, content);
    logToolResult({ output: `Wrote ${content.length} bytes to ${path}`, success: true });

    return {
      output: `Successfully wrote file: ${path}`,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to write file: ${message}`, error);
  }
}

async function listDirectory(args: unknown): Promise<ToolResult> {
  try {
    const { path } = listDirectorySchema.parse(args);
    logToolCall("list_directory", { path });

    // Use Bun's shell API to list directory contents
    const result = await Bun.$`ls -la ${path}`.quiet();
    const output = result.stdout.toString();

    if (result.exitCode !== 0) {
      return {
        error: `Directory not found or permission denied: ${path}`,
        output: "",
        success: false,
      };
    }

    const entryCount = output.split("\n").filter((line) => line.trim().length > 0).length;
    logToolResult({ output: `Listed ${entryCount} entries`, success: true });

    return {
      output,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to list directory: ${message}`, error);
  }
}

export const fsTools: Tool[] = [
  {
    description: "Read the contents of a file",
    execute: readFile,
    name: "read_file",
    parameters: readFileSchema,
  },
  {
    description: "Write content to a file (creates or overwrites)",
    execute: writeFile,
    name: "write_file",
    parameters: writeFileSchema,
  },
  {
    description: "List files and directories in a given path",
    execute: listDirectory,
    name: "list_directory",
    parameters: listDirectorySchema,
  },
];
