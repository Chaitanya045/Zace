import type { AgentContext } from "../types/agent";

import { SCRIPT_REGISTRY_PATH } from "../agent/scripts";
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

SCRIPT REGISTRY:
- File path: ${SCRIPT_REGISTRY_PATH}
- TSV columns: id, path, purpose, last_touched_step, times_used
- Query scripts by running shell commands against this file (rg/awk/sed) before deciding to create a new script.

AVAILABLE TOOLS:
${getToolDescriptions()}

INSTRUCTIONS:
1. Analyze the task and current state
2. Reuse existing runtime scripts whenever possible instead of rewriting long shell commands.
3. Search the registry file before creating a new script.
4. If a required capability is missing, create or update a script under .zace/runtime/scripts.
   New scripts must include a purpose header comment: # zace-purpose: <one line purpose>
5. For every script creation or update, ensure command output includes:
   ZACE_SCRIPT_REGISTER|<script_id>|<script_path>|<purpose>
6. For script runs, prefer including:
   ZACE_SCRIPT_USE|<script_id>
7. If the task is complete, respond with "COMPLETE: <summary>"
8. If blocked or uncertain, respond with "BLOCKED: <reason>"
9. Otherwise, respond with "CONTINUE: <reasoning>" followed by a tool call in JSON format:
   {"name": "tool_name", "arguments": {...}}
10. Keep each step small and deterministic. Prefer one command per step.

Your response should be clear and actionable.`;

}
