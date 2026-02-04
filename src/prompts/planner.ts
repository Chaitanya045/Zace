import type { AgentContext } from "../types/agent";

import { getToolDescriptions } from "../tools";

export function buildPlannerPrompt(context: AgentContext): string {
  const { currentStep, fileSummaries, maxSteps, steps, task } = context;

  const stepHistory = steps
    .slice(-3)
    .map(
      (s) =>
        `Step ${s.step} (${s.state}): ${s.reasoning}${s.toolCall ? `\n  Tool: ${s.toolCall.name}` : ""}${s.toolResult ? `\n  Result: ${s.toolResult.success ? "✓" : "✗"} ${s.toolResult.output.slice(0, 100)}` : ""}`
    )
    .join("\n\n");

  const fileContext = fileSummaries.size > 0
    ? `\n\nRelevant files:\n${Array.from(fileSummaries.entries())
        .map(([path, summary]) => `- ${path}: ${summary.slice(0, 200)}`)
        .join("\n")}`
    : "";

  return `You are the PLANNER. Your job is to understand the task and decide WHAT to do next.

TASK: ${task}

CURRENT STEP: ${currentStep} / ${maxSteps}

${stepHistory ? `RECENT HISTORY:\n${stepHistory}` : "This is the first step."}${fileContext}

AVAILABLE TOOLS:
${getToolDescriptions()}

INSTRUCTIONS:
1. Analyze the task and current state
2. Decide what the next action should be
3. If the task is complete, respond with "COMPLETE: <summary>"
4. If blocked or uncertain, respond with "BLOCKED: <reason>"
5. Otherwise, respond with "CONTINUE: <reasoning>" followed by a tool call in JSON format:
   {"name": "tool_name", "arguments": {...}}

Your response should be clear and actionable.`;

}
