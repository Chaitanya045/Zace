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

const DEFAULT_TIMEOUT_MS = 120_000;

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
    const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Command timed out after ${String(effectiveTimeout)}ms`));
      }, effectiveTimeout);
    });

    const result = await Promise.race([proc, timeoutPromise]);

    if (timeoutId) clearTimeout(timeoutId);

    const output = result.stdout.toString();
    const errorOutput = result.stderr.toString();

    if (result.exitCode !== 0) {
      const failedOutput = errorOutput || output;
      logToolResult({ output: failedOutput, success: false });
      return {
        error: `Command failed with exit code ${result.exitCode}`,
        output: failedOutput,
        success: false,
      };
    }

    const successOutput = output || "Command executed successfully (no output)";
    logToolResult({ output: successOutput, success: true });

    return {
      output: successOutput,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ToolExecutionError(`Failed to execute command: ${message}`, error);
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
];
