import { z } from "zod";

import type { Tool, ToolResult } from "../types/tool";

import { ToolExecutionError } from "../utils/errors";
import { logToolCall, logToolResult } from "../utils/logger";

const executeCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().optional(),
});

const executeCodeSchema = z.object({
  code: z.string().min(1),
  cwd: z.string().optional(),
  language: z.enum(["javascript", "python", "shell", "typescript"]),
});

async function executeCommand(args: unknown): Promise<ToolResult> {
  try {
    const { command, cwd, env, timeout } = executeCommandSchema.parse(args);
    logToolCall("execute_command", { command, cwd, env, timeout });

    const proc = Bun.$`sh -c ${command}`.cwd(cwd ?? process.cwd()).quiet();

    // Set custom environment variables if provided
    if (env) {
      proc.env(env as Record<string, string | undefined>);
    }

    // Handle timeout if specified
    let timeoutId: Timer | undefined;
    const timeoutPromise = timeout
      ? new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Command timed out after ${timeout}ms`));
          }, timeout);
        })
      : null;

    const result = timeoutPromise ? await Promise.race([proc, timeoutPromise]) : await proc;

    if (timeoutId) clearTimeout(timeoutId);

    const output = result.stdout.toString();
    const errorOutput = result.stderr.toString();

    if (result.exitCode !== 0) {
      logToolResult({ output: errorOutput, success: false });
      return {
        error: `Command failed with exit code ${result.exitCode}`,
        output: errorOutput || output,
        success: false,
      };
    }

    logToolResult({ output: `Command executed successfully`, success: true });

    return {
      output: output || "Command executed successfully (no output)",
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to execute command: ${message}`, error);
  }
}

async function executeCode(args: unknown): Promise<ToolResult> {
  try {
    const { code, cwd, language } = executeCodeSchema.parse(args);
    logToolCall("execute_code", { cwd, language, linesOfCode: code.split("\n").length });

    let command: string;

    switch (language) {
      case "javascript":
      case "typescript":
        // Execute with Bun runtime
        command = `bun -e '${code.replace(/'/g, "'\\''")}'`;
        break;

      case "python":
        command = `python3 -c '${code.replace(/'/g, "'\\''")}'`;
        break;

      case "shell":
        command = code;
        break;
    }

    const result = await Bun.$`sh -c ${command}`.cwd(cwd ?? process.cwd()).quiet();

    const output = result.stdout.toString();
    const errorOutput = result.stderr.toString();

    if (result.exitCode !== 0) {
      logToolResult({ output: errorOutput, success: false });
      return {
        error: `Code execution failed with exit code ${result.exitCode}`,
        output: errorOutput || output,
        success: false,
      };
    }

    logToolResult({ output: `Code executed successfully`, success: true });

    return {
      output: output || "Code executed successfully (no output)",
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to execute code: ${message}`, error);
  }
}

export const shellTools: Tool[] = [
  {
    description:
      "Execute a shell command and return its output. Supports custom working directory, environment variables, and timeout.",
    execute: executeCommand,
    name: "execute_command",
    parameters: executeCommandSchema,
  },
  {
    description:
      "Execute code in specified language (javascript, typescript, python, shell). Returns output or errors.",
    execute: executeCode,
    name: "execute_code",
    parameters: executeCodeSchema,
  },
];
