import type { ToolCall } from "../types/tool";

export function buildExecutorPrompt(toolCall: ToolCall, toolResult: { success: boolean; output: string; error?: string }): string {
  return `You are the EXECUTOR. A tool was called and returned a result.

TOOL CALLED: ${toolCall.name}
ARGUMENTS: ${JSON.stringify(toolCall.arguments, null, 2)}

RESULT:
Success: ${toolResult.success}
Output: ${toolResult.output}
${toolResult.error ? `Error: ${toolResult.error}` : ""}

INSTRUCTIONS:
1. Analyze the tool result
2. Determine if the action succeeded or failed
3. Provide a brief summary of what happened
4. Decide whether retrying the same command is likely to help
5. Respond with strict JSON only using this schema:
   {"analysis":"<short summary>","shouldRetry":true|false}

Do not include markdown, prose, or code fences outside the JSON object.`;

}
