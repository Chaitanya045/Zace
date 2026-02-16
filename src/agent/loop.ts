import type { LlmClient } from "../llm/client";
import type { AgentContext, AgentState } from "../types/agent";
import type { AgentConfig } from "../types/config";
import type { ToolResult } from "../types/tool";

import { buildSystemPrompt } from "../prompts/system";
import { allTools } from "../tools";
import { appendSessionMessage, getSessionFilePath } from "../tools/session";
import { AgentError } from "../utils/errors";
import { log, logError, logStep } from "../utils/logger";
import {
  maybeCompactContext,
} from "./compaction";
import {
  describeCompletionPlan,
  resolveCompletionPlan,
  type CompletionGate,
} from "./completion";
import { analyzeToolResult, executeToolCall } from "./executor";
import { Memory } from "./memory";
import { plan } from "./planner";
import { assessCommandSafety } from "./safety";
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

export interface RunAgentLoopOptions {
  sessionId?: string;
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

type CompletionGateResult = {
  gate: CompletionGate;
  result: ToolResult;
};

async function runCompletionGates(gates: CompletionGate[]): Promise<CompletionGateResult[]> {
  const results: CompletionGateResult[] = [];

  for (const gate of gates) {
    let result: ToolResult;
    try {
      result = await executeToolCall({
        arguments: {
          command: gate.command,
        },
        name: "execute_command",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown gate execution error";
      result = {
        error: errorMessage,
        output: errorMessage,
        success: false,
      };
    }
    results.push({ gate, result });
  }

  return results;
}

function parsePlannerCompletionGates(commands: string[] | undefined): CompletionGate[] {
  if (!commands || commands.length === 0) {
    return [];
  }

  const gates: CompletionGate[] = [];
  const seenCommands = new Set<string>();

  for (const rawCommand of commands) {
    const command = rawCommand.trim();
    if (!command || seenCommands.has(command)) {
      continue;
    }

    seenCommands.add(command);
    gates.push({
      command,
      label: `planner:${gates.length + 1}`,
    });
  }

  return gates;
}

function buildCompletionFailureMessage(gateResults: CompletionGateResult[]): string {
  const failedGates = gateResults.filter((gateResult) => !gateResult.result.success);
  if (failedGates.length === 0) {
    return "All completion gates passed.";
  }

  return failedGates
    .map((gateResult) => {
      const output = gateResult.result.output.replace(/\s+/gu, " ").trim();
      const detail = output.length > 180 ? `${output.slice(0, 180)}...` : output;
      return `${gateResult.gate.label} failed (${gateResult.gate.command}): ${detail}`;
    })
    .join(" | ");
}

function getExecuteCommandText(argumentsObject: Record<string, unknown>): string | undefined {
  const commandValue = argumentsObject.command;
  if (typeof commandValue !== "string") {
    return undefined;
  }

  const command = commandValue.trim();
  if (!command) {
    return undefined;
  }

  return command;
}

async function getDestructiveCommandReason(
  client: LlmClient,
  config: AgentConfig,
  command: string
): Promise<null | string> {
  if (!config.requireRiskyConfirmation || command.includes(config.riskyConfirmationToken)) {
    return null;
  }

  const safetyAssessment = await assessCommandSafety(client, command);
  if (!safetyAssessment.isDestructive) {
    return null;
  }

  return safetyAssessment.reason;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const parsed = Math.trunc(value);
  if (parsed < 0) {
    return undefined;
  }

  return parsed;
}

function getRetryConfiguration(
  toolCall: { arguments: Record<string, unknown>; name: string },
  maxStepRetries: number
): {
  maxRetries: number;
  retryMaxDelayMs?: number;
} {
  if (toolCall.name !== "execute_command") {
    return {
      maxRetries: maxStepRetries,
    };
  }

  const requestedMaxRetries = parseNonNegativeInteger(toolCall.arguments.maxRetries);
  const retryMaxDelayMs = parseNonNegativeInteger(toolCall.arguments.retryMaxDelayMs);

  return {
    maxRetries: requestedMaxRetries === undefined
      ? maxStepRetries
      : Math.min(requestedMaxRetries, maxStepRetries),
    retryMaxDelayMs,
  };
}

function getRetryDelayMs(
  retryDelayMs: number | undefined,
  retryMaxDelayMs: number | undefined
): number {
  if (typeof retryDelayMs !== "number" || !Number.isFinite(retryDelayMs)) {
    return 0;
  }

  const normalizedDelay = Math.max(0, Math.trunc(retryDelayMs));
  if (retryMaxDelayMs === undefined) {
    return normalizedDelay;
  }

  return Math.min(normalizedDelay, retryMaxDelayMs);
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function runAgentLoop(
  client: LlmClient,
  config: AgentConfig,
  task: string,
  options?: RunAgentLoopOptions
): Promise<AgentResult> {
  log(`Starting agent loop for task: ${task}`);

  const sessionId = options?.sessionId;
  const sessionFilePath = sessionId ? getSessionFilePath(sessionId) : undefined;
  const memory = new Memory({
    messageSink: sessionId
      ? async (message) => {
          await appendSessionMessage(sessionId, {
            content: message.content,
            role: message.role,
          });
        }
      : undefined,
  });
  let context = createInitialContext(task, config.maxSteps);
  let completionPlan = resolveCompletionPlan(task);
  let lastCompletionGateFailure: null | string = null;
  const getCompletionCriteria = (): string[] => describeCompletionPlan(completionPlan);

  // Build dynamic system prompt with runtime context
  const systemPrompt = buildSystemPrompt({
    availableTools: allTools.map((tool) => tool.name),
    commandAllowPatterns: config.commandAllowPatterns,
    commandDenyPatterns: config.commandDenyPatterns,
    completionCriteria: getCompletionCriteria(),
    currentDirectory: process.cwd(),
    maxSteps: config.maxSteps,
    platform: process.platform,
    requireRiskyConfirmation: config.requireRiskyConfirmation,
    riskyConfirmationToken: config.riskyConfirmationToken,
    sessionFilePath,
    sessionId,
    verbose: config.verbose,
  });

  // Initialize with system prompt
  memory.addMessage("system", systemPrompt);

  try {
    if (sessionId) {
      await appendSessionMessage(sessionId, {
        content: task,
        role: "user",
      });
    }

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
      const planResult = await plan(client, context, memory, {
        completionCriteria: getCompletionCriteria(),
        stream: config.stream,
      });

      // Add planning reasoning to memory
      memory.addMessage("assistant", `Planning: ${planResult.reasoning}`);

      const compactionResult = await maybeCompactContext({
        client,
        config,
        memory,
        plannerInputTokens: planResult.usage?.inputTokens,
        stepNumber,
      });
      if (compactionResult.compacted) {
        const ratioPercent =
          typeof compactionResult.usageRatio === "number"
            ? Math.round(compactionResult.usageRatio * 100)
            : Math.round(config.compactionTriggerRatio * 100);
        memory.addMessage(
          "assistant",
          `Context compacted after planner input reached ${String(ratioPercent)}% of model context.`
        );
      }

      // Handle different plan outcomes
      if (planResult.action === "complete") {
        const plannerCompletionGates = parsePlannerCompletionGates(planResult.completionGateCommands);
        if (completionPlan.gates.length === 0 && plannerCompletionGates.length > 0) {
          completionPlan = {
            ...completionPlan,
            gates: plannerCompletionGates,
          };
          memory.addMessage(
            "assistant",
            `Planner supplied completion gates: ${describeCompletionPlan(completionPlan).join(" | ")}`
          );
        }

        if (completionPlan.gates.length === 0 && !planResult.completionGatesDeclaredNone) {
          const failureMessage =
            "No completion gates available. Provide `GATES: <command_1>;;<command_2>` with COMPLETE, use DONE_CRITERIA, or explicitly declare `GATES: none`.";
          lastCompletionGateFailure = failureMessage;
          context = addStep(context, {
            reasoning: `Completion requested without gates. ${failureMessage}`,
            state: "executing",
            step: stepNumber,
            toolCall: null,
            toolResult: null,
          });
          memory.addMessage(
            "assistant",
            `Completion gate check result: ${failureMessage}`
          );
          logStep(stepNumber, `Completion blocked by missing gates: ${failureMessage}`);
          continue;
        }

        if (completionPlan.gates.length > 0) {
          for (const gate of completionPlan.gates) {
            const destructiveReason = await getDestructiveCommandReason(client, config, gate.command);
            if (!destructiveReason) {
              continue;
            }

            const confirmationMessage =
              `Destructive completion gate requires confirmation: ${destructiveReason}\n` +
              `Command: ${gate.command}\n` +
              `Reply with "${config.riskyConfirmationToken}" and ask me to continue.`;
            memory.addMessage("assistant", confirmationMessage);
            context = addStep(context, {
              reasoning: `Waiting for explicit confirmation before running destructive completion gate. ${destructiveReason}`,
              state: "waiting_for_user",
              step: stepNumber,
              toolCall: null,
              toolResult: null,
            });
            return {
              context,
              finalState: "waiting_for_user",
              message: confirmationMessage,
              success: false,
            };
          }

          const gateResults = await runCompletionGates(completionPlan.gates);
          const failureMessage = buildCompletionFailureMessage(gateResults);

          memory.addMessage(
            "assistant",
            `Completion gate check result: ${failureMessage}`
          );

          const hasFailure = gateResults.some((gateResult) => !gateResult.result.success);
          if (hasFailure) {
            lastCompletionGateFailure = failureMessage;
            context = addStep(context, {
              reasoning: `Completion requested but gates failed. ${failureMessage}`,
              state: "executing",
              step: stepNumber,
              toolCall: null,
              toolResult: null,
            });
            logStep(stepNumber, `Completion blocked by gates: ${failureMessage}`);
            continue;
          }
        }

        context = addStep(context, {
          reasoning: planResult.reasoning,
          state: "completed",
          step: stepNumber,
          toolCall: null,
          toolResult: null,
        });
        lastCompletionGateFailure = null;
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

      if (
        config.requireRiskyConfirmation &&
        planResult.toolCall.name === "execute_command"
      ) {
        const command = getExecuteCommandText(planResult.toolCall.arguments);
        if (command) {
          const destructiveReason = await getDestructiveCommandReason(client, config, command);
          if (destructiveReason) {
            const confirmationMessage =
              `Destructive command requires confirmation: ${destructiveReason}\n` +
              `Command: ${command}\n` +
              `Reply with "${config.riskyConfirmationToken}" and ask me to continue.`;
            memory.addMessage("assistant", confirmationMessage);
            context = addStep(context, {
              reasoning: `Waiting for explicit confirmation before running destructive command. ${destructiveReason}`,
              state: "waiting_for_user",
              step: stepNumber,
              toolCall: {
                arguments: planResult.toolCall.arguments,
                name: planResult.toolCall.name,
              },
              toolResult: null,
            });
            return {
              context,
              finalState: "waiting_for_user",
              message: confirmationMessage,
              success: false,
            };
          }
        }
      }

      context = transitionState(context, "executing");

      try {
        const toolCall = {
          arguments: planResult.toolCall.arguments,
          name: planResult.toolCall.name,
        };

        const maxStepRetries = Math.max(0, context.maxSteps - stepNumber);
        const retryConfiguration = getRetryConfiguration(toolCall, maxStepRetries);

        let attempt = 0;
        let analysis: Awaited<ReturnType<typeof analyzeToolResult>> | null = null;
        let toolResult: ToolResult = {
          error: "Tool was not executed",
          output: "",
          success: false,
        };

        while (true) {
          attempt += 1;
          toolResult = await executeToolCall(toolCall);

          memory.addMessage(
            "tool",
            `Tool ${planResult.toolCall.name} attempt ${String(attempt)} result: ${toolResult.output}`
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

          const retriesUsed = attempt - 1;
          const retryEvaluationNeeded = !toolResult.success && retriesUsed < retryConfiguration.maxRetries;
          const shouldAnalyze =
            config.executorAnalysis === "always" ||
            (config.executorAnalysis === "on_failure" && !toolResult.success) ||
            retryEvaluationNeeded;

          analysis = shouldAnalyze
            ? await analyzeToolResult(client, toolCall, toolResult, {
                retryContext: {
                  attempt,
                  maxRetries: retryConfiguration.maxRetries,
                },
                stream: config.stream,
              })
            : null;

          if (analysis) {
            memory.addMessage("assistant", `Execution analysis: ${analysis.analysis}`);
          }

          if (toolResult.success || !retryEvaluationNeeded || !analysis?.shouldRetry) {
            break;
          }

          const retryDelayMs = getRetryDelayMs(
            analysis.retryDelayMs,
            retryConfiguration.retryMaxDelayMs
          );
          memory.addMessage(
            "assistant",
            `Retrying tool ${planResult.toolCall.name} after ${String(retryDelayMs)}ms (attempt ${String(attempt + 1)} of ${String(retryConfiguration.maxRetries + 1)}).`
          );
          logStep(
            stepNumber,
            `Retry scheduled for tool ${planResult.toolCall.name}: delay=${String(retryDelayMs)}ms, attempt=${String(attempt + 1)}`
          );
          await sleep(retryDelayMs);
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
    const maxStepsMessage = lastCompletionGateFailure
      ? `Maximum steps (${context.maxSteps}) reached. Last completion gate failure: ${lastCompletionGateFailure}`
      : `Maximum steps (${context.maxSteps}) reached without completing the task`;

    return {
      context,
      finalState: "blocked",
      message: maxStepsMessage,
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
  } finally {
    try {
      await memory.flushMessageSink();
    } catch (error) {
      logError("Failed to flush message sink", error);
    }
  }
}
