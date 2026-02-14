import type { LlmClient } from "../llm/client";
import type { AgentContext, AgentState } from "../types/agent";
import type { AgentConfig } from "../types/config";

import { buildSystemPrompt } from "../prompts/system";
import { allTools } from "../tools";
import { AgentError } from "../utils/errors";
import { log, logError, logStep } from "../utils/logger";
import { analyzeToolResult, executeToolCall } from "./executor";
import { Memory } from "./memory";
import { plan } from "./planner";
import {
  buildDiscoverScriptsCommand,
  buildRegistrySyncCommand,
  SCRIPT_REGISTRY_PATH,
  updateScriptCatalogFromOutput,
} from "./scripts";
import { addStep, createInitialContext, transitionState, updateScriptCatalog } from "./state";

export interface AgentResult {
  success: boolean;
  finalState: AgentState;
  context: AgentContext;
  message: string;
}

const DISCOVER_SCRIPTS_COMMAND = buildDiscoverScriptsCommand();

async function syncScriptRegistry(catalog: AgentContext["scriptCatalog"]): Promise<void> {
  await executeToolCall({
    arguments: {
      command: buildRegistrySyncCommand(catalog),
      timeout: 30_000,
    },
    name: "execute_command",
  });
}

export async function runAgentLoop(
  client: LlmClient,
  config: AgentConfig,
  task: string
): Promise<AgentResult> {
  log(`Starting agent loop for task: ${task}`);

  const memory = new Memory();
  let context = createInitialContext(task, config.maxSteps);

  // Build dynamic system prompt with runtime context
  const systemPrompt = buildSystemPrompt({
    availableTools: allTools.map((tool) => tool.name),
    commandAllowPatterns: config.commandAllowPatterns,
    commandDenyPatterns: config.commandDenyPatterns,
    currentDirectory: process.cwd(),
    maxSteps: config.maxSteps,
    platform: process.platform,
    requireRiskyConfirmation: config.requireRiskyConfirmation,
    riskyConfirmationToken: config.riskyConfirmationToken,
    verbose: config.verbose,
  });

  // Initialize with system prompt
  memory.addMessage("system", systemPrompt);

  try {
    const discoveredScripts = await executeToolCall({
      arguments: {
        command: DISCOVER_SCRIPTS_COMMAND,
        timeout: 30_000,
      },
      name: "execute_command",
    });
    const discoveredCatalogUpdate = updateScriptCatalogFromOutput(
      context.scriptCatalog,
      discoveredScripts.output,
      0
    );
    context = updateScriptCatalog(context, discoveredCatalogUpdate.catalog);
    await syncScriptRegistry(context.scriptCatalog);
    if (discoveredCatalogUpdate.notes.length > 0) {
      memory.addMessage(
        "assistant",
        `Startup script discovery complete. Registered or updated ${discoveredCatalogUpdate.notes.length} scripts in ${SCRIPT_REGISTRY_PATH}.`
      );
    }

    while (context.currentStep < context.maxSteps) {
      const stepNumber = context.currentStep + 1;
      logStep(stepNumber, `Starting step ${stepNumber}/${context.maxSteps}`);

      // Planning phase
      context = transitionState(context, "planning");
      const planResult = await plan(client, context, memory, { stream: config.stream });

      // Add planning reasoning to memory
      memory.addMessage("assistant", `Planning: ${planResult.reasoning}`);

      // Handle different plan outcomes
      if (planResult.action === "complete") {
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "completed",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        return {
          context,
          finalState: "completed",
          message: planResult.reasoning,
          success: true,
        };
      }

      if (planResult.action === "blocked") {
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "blocked",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        return {
          context,
          finalState: "blocked",
          message: planResult.reasoning,
          success: false,
        };
      }

      if (planResult.action === "ask_user") {
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "waiting_for_user",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        return {
          context,
          finalState: "waiting_for_user",
          message: planResult.reasoning,
          success: false,
        };
      }

      // Execution phase
      if (!planResult.toolCall) {
        logStep(stepNumber, "No tool call specified, continuing...");
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "executing",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        continue;
      }

      context = transitionState(context, "executing");

      try {
        const toolCall = {
          arguments: planResult.toolCall.arguments,
          name: planResult.toolCall.name,
        };

        // Execute the tool
        const toolResult = await executeToolCall(toolCall);

        // Add tool result to memory
        memory.addMessage(
          "tool",
          `Tool ${planResult.toolCall.name} result: ${toolResult.output}`
        );

        const scriptCatalogUpdate = updateScriptCatalogFromOutput(
          context.scriptCatalog,
          toolResult.output,
          stepNumber
        );
        context = updateScriptCatalog(context, scriptCatalogUpdate.catalog);
        if (scriptCatalogUpdate.notes.length > 0) {
          await syncScriptRegistry(context.scriptCatalog);
          memory.addMessage(
            "assistant",
            `Script registry updated with ${scriptCatalogUpdate.notes.length} marker events at ${SCRIPT_REGISTRY_PATH}.`
          );
        }

        // Optionally analyze tool result (to control cost)
        const shouldAnalyze =
          config.executorAnalysis === "always" ||
          (config.executorAnalysis === "on_failure" && !toolResult.success);

        const analysis = shouldAnalyze
          ? await analyzeToolResult(client, toolCall, toolResult, { stream: config.stream })
          : null;

        if (analysis) {
          memory.addMessage("assistant", `Execution analysis: ${analysis.analysis}`);
        }

        // Record step
        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "executing",
          step: stepNumber,
          toolCall: {
            arguments: planResult.toolCall.arguments,
            name: planResult.toolCall.name,
          },
          toolResult,
        });

        // If tool failed and retry is suggested, log it
        if (!toolResult.success) {
          logStep(
            stepNumber,
            `Tool execution failed: ${toolResult.error ?? "Unknown error"}. Retry suggested: ${analysis ? String(analysis.shouldRetry) : "unknown"}`
          );
          // Continue to next step - planner will decide on retry or alternative approach
        }
      } catch (error) {
        logError(`Step ${stepNumber} failed`, error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "error",
          step: stepNumber,
          toolCall: planResult.toolCall
            ? {
                arguments: planResult.toolCall.arguments,
                name: planResult.toolCall.name,
              }
            : null,
          toolResult: {
            error: errorMessage,
            output: "",
            success: false,
          },
        });

        // If it's a critical error, stop
        if (error instanceof AgentError && error.code === "VALIDATION_ERROR") {
          return {
            context,
            finalState: "error",
            message: `Validation error: ${errorMessage}`,
            success: false,
          };
        }
      }
    }

    // Max steps reached
    return {
      context,
      finalState: "blocked",
      message: `Maximum steps (${context.maxSteps}) reached without completing the task`,
      success: false,
    };
  } catch (error) {
    logError("Agent loop failed", error);
    return {
      context,
      finalState: "error",
      message: error instanceof Error ? error.message : "Unknown error occurred",
      success: false,
    };
  }
}
