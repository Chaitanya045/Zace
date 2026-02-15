import type { ToolCall, ToolResult } from "../types/tool";

export interface ExecutorRetryContext {
  attempt: number;
  maxRetries: number;
}

export function buildExecutorPrompt(
  toolCall: ToolCall,
  toolResult: ToolResult,
  retryContext?: ExecutorRetryContext
): string {
  const retryContextText = retryContext
    ? `\nRETRY CONTEXT:\nAttempt: ${String(retryContext.attempt)}\nMax retries: ${String(retryContext.maxRetries)}`
    : "";
  return `You are the EXECUTOR. A tool was called and returned a result.

TOOL CALLED: ${toolCall.name}
ARGUMENTS: ${JSON.stringify(toolCall.arguments, null, 2)}

RESULT:
Success: ${toolResult.success}
Output: ${toolResult.output}
${toolResult.error ? `Error: ${toolResult.error}` : ""}
Artifacts: ${toolResult.artifacts ? JSON.stringify(toolResult.artifacts) : "none"}${retryContextText}

INSTRUCTIONS:
1. Analyze the tool result
2. Determine if the action succeeded or failed
3. Provide a brief summary of what happened
4. Decide whether the failure appears transient and retrying the same command is likely to help
5. If retrying, propose retryDelayMs as the wait time in milliseconds before the next attempt
6. Respond with strict JSON only using this schema:
   {"analysis":"<short summary>","shouldRetry":true|false,"retryDelayMs":<integer>=0}

Do not include markdown, prose, or code fences outside the JSON object.`;

}
