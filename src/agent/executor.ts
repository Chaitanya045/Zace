import type { LlmClient } from "../llm/client";
import type { ToolCall, ToolResult } from "../types/tool";

import { buildExecutorPrompt } from "../prompts/executor";
import { buildSystemPrompt } from "../prompts/system";
import { getToolByName } from "../tools";
import { ToolExecutionError, ValidationError } from "../utils/errors";
import { log, logStep, logToolCall, logToolResult } from "../utils/logger";

export interface ExecutionResult {
  analysis: string;
  shouldRetry: boolean;
  toolResult: ToolResult;
}

type ExecuteOptions = {
  stream?: boolean;
};

export async function executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
  logStep(0, `Executing tool: ${toolCall.name}`);

  const tool = getToolByName(toolCall.name);
  if (!tool) {
    throw new ValidationError(`Unknown tool: ${toolCall.name}`);
  }

  // Validate arguments against tool schema
  try {
    const validatedArgs = tool.parameters.parse(toolCall.arguments);
    logToolCall(toolCall.name, validatedArgs);

    // Execute the tool
    const result = await tool.execute(validatedArgs);
    logToolResult(result);

    return result;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof ToolExecutionError) {
      throw error;
    }

    // Zod validation error
    if (error && typeof error === "object" && "issues" in error) {
      throw new ValidationError(
        `Invalid arguments for tool ${toolCall.name}: ${JSON.stringify(error)}`
      );
    }

    throw new ToolExecutionError(
      `Tool execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      error
    );
  }
}

export async function executeAndAnalyze(
  client: LlmClient,
  toolCall: ToolCall,
  options?: ExecuteOptions
): Promise<ExecutionResult> {
  // Execute the tool
  const toolResult = await executeToolCall(toolCall);

  // Use LLM to analyze the result
  const prompt = buildExecutorPrompt(toolCall, toolResult);
  
  // Build focused system prompt for execution analysis
  const systemPrompt = buildSystemPrompt({
    availableTools: [toolCall.name],
    currentDirectory: process.cwd(),
  });

  const messages = [
    { content: systemPrompt, role: "system" as const },
    { content: prompt, role: "user" as const },
  ];

  if (options?.stream) {
    process.stdout.write(`\n\n[LLM:executor:${toolCall.name}]\n`);
  }
  const response = await client.chat(
    { messages },
    options?.stream
      ? {
          onToken: (token) => {
            process.stdout.write(token);
          },
          stream: true,
        }
      : undefined
  );
  if (options?.stream) {
    process.stdout.write("\n");
  }
  const analysis = response.content.trim();

  log(`Executor analysis: ${analysis.slice(0, 200)}...`);

  // Determine if retry is needed based on failure and analysis
  const shouldRetry =
    !toolResult.success &&
    (analysis.toLowerCase().includes("retry") ||
      analysis.toLowerCase().includes("try again"));

  return {
    analysis,
    shouldRetry,
    toolResult,
  };
}
