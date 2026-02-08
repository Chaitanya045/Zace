import type { AgentContext } from "../types/agent";

import { getToolDescriptions } from "../tools";

export function buildPlannerPrompt(context: AgentContext): string {
  const { currentStep, fileSummaries, maxSteps, scriptCatalog, steps, task } = context;

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
  const scriptContext = scriptCatalog.size > 0
    ? `\n\nKnown runtime scripts:\n${Array.from(scriptCatalog.values())
        .map(
          (script) =>
            `- ${script.id}: ${script.purpose} (path: ${script.path}, uses: ${script.timesUsed}, last touched step: ${script.lastTouchedStep})`
        )
        .join("\n")}`
    : "\n\nKnown runtime scripts:\n- none";

  return `You are the PLANNER. Your job is to understand the task and decide WHAT to do next.

TASK: ${task}

CURRENT STEP: ${currentStep} / ${maxSteps}

${stepHistory ? `RECENT HISTORY:\n${stepHistory}` : "This is the first step."}${fileContext}${scriptContext}

AVAILABLE TOOLS:
${getToolDescriptions()}

INSTRUCTIONS:
1. Analyze the task and current state
2. Reuse existing runtime scripts whenever possible instead of rewriting long shell commands.
3. If a required capability is missing, create or update a script under .zace/runtime/scripts.
   New scripts must include a purpose header comment: # zace-purpose: <one line purpose>
4. For every script creation or update, ensure command output includes:
   ZACE_SCRIPT_REGISTER|<script_id>|<script_path>|<purpose>
5. For script runs, prefer including:
   ZACE_SCRIPT_USE|<script_id>
6. If the task is complete, respond with "COMPLETE: <summary>"
7. If blocked or uncertain, respond with "BLOCKED: <reason>"
8. Otherwise, respond with "CONTINUE: <reasoning>" followed by a tool call in JSON format:
   {"name": "tool_name", "arguments": {...}}
9. Keep each step small and deterministic. Prefer one command per step.

Your response should be clear and actionable.`;

}
