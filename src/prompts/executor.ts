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
4. Suggest next steps if applicable

Your response should be concise and focused on the execution outcome.`;

}
