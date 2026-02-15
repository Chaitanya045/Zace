import { z } from "zod";

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

export interface ToolAnalysisResult {
  analysis: string;
  shouldRetry: boolean;
}

type ExecuteOptions = {
  stream?: boolean;
};

const executorAnalysisSchema = z.object({
  analysis: z.string().min(1),
  shouldRetry: z.boolean(),
});

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

export async function analyzeToolResult(
  client: LlmClient,
  toolCall: ToolCall,
  toolResult: ToolResult,
  options?: ExecuteOptions
): Promise<ToolAnalysisResult> {
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
  const jsonMatch = analysis.match(/\{[\s\S]*\}/u);

  let parsedAnalysis: ToolAnalysisResult;
  if (!jsonMatch) {
    parsedAnalysis = {
      analysis,
      shouldRetry: false,
    };
  } else {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const validated = executorAnalysisSchema.parse(parsed);
      parsedAnalysis = {
        analysis: validated.analysis,
        shouldRetry: validated.shouldRetry && !toolResult.success,
      };
    } catch {
      parsedAnalysis = {
        analysis,
        shouldRetry: false,
      };
    }
  }

  log(`Executor analysis: ${parsedAnalysis.analysis.slice(0, 200)}...`);

  return {
    analysis: parsedAnalysis.analysis,
    shouldRetry: parsedAnalysis.shouldRetry,
  };
}

export async function executeAndAnalyze(
  client: LlmClient,
  toolCall: ToolCall,
  options?: ExecuteOptions
): Promise<ExecutionResult> {
  // Execute the tool
  const toolResult = await executeToolCall(toolCall);
  const analysis = await analyzeToolResult(client, toolCall, toolResult, options);

  return {
    analysis: analysis.analysis,
    shouldRetry: analysis.shouldRetry,
    toolResult,
  };
}
