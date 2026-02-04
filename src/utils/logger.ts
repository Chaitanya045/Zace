import type { AgentConfig } from "../types/config";

let config: AgentConfig | null = null;

export function initializeLogger(agentConfig: AgentConfig): void {
  config = agentConfig;
}

function shouldLog(): boolean {
  return config?.verbose ?? false;
}

export function log(message: string): void {
  if (shouldLog()) {
    console.log(`[LOG] ${message}`);
  }
}

export function logError(message: string, error?: unknown): void {
  console.error(`[ERROR] ${message}`);
  if (error instanceof Error && shouldLog()) {
    console.error(error.stack);
  }
}

export function logStep(step: number, message: string): void {
  if (shouldLog()) {
    console.log(`[STEP ${step}] ${message}`);
  }
}

export function logToolCall(name: string, args: unknown): void {
  if (shouldLog()) {
    console.log(`[TOOL] ${name}`, args);
  }
}

export function logToolResult(result: { success: boolean; output: string }): void {
  if (shouldLog()) {
    const status = result.success ? "✓" : "✗";
    console.log(`[TOOL RESULT] ${status} ${result.output.slice(0, 100)}`);
  }
}
