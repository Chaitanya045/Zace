import type { AgentContext } from "../types/agent";

import { SCRIPT_REGISTRY_PATH } from "../agent/scripts";
import { getToolDescriptions } from "../tools";

export function buildPlannerPrompt(context: AgentContext, completionCriteria?: string[]): string {
  const { currentStep, fileSummaries, maxSteps, steps, task } = context;
  const criteria = completionCriteria && completionCriteria.length > 0
    ? completionCriteria
    : ["No completion gates configured"];
  const completionCriteriaText = criteria
    .map((criterion) => `- ${criterion}`)
    .join("\n");

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

COMPLETION GATES:
${completionCriteriaText}

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
7. If user clarification is required, respond with "ASK_USER: <single clear question>"
8. Destructive shell commands require explicit user confirmation before execution.
   After user confirms, include the configured confirmation token in the command as a shell comment.
9. Do not respond with COMPLETE unless all completion gates pass.
10. If completion gates are missing and validation should run, discover project-specific check commands and include them when completing:
   GATES: <command_1>;;<command_2> (single line, shell commands only)
11. If no validation gates are required, include:
   GATES: none
12. If the task is complete, respond with "COMPLETE: <summary>" and include a GATES line when applicable.
13. If blocked and cannot proceed without non-user intervention, respond with "BLOCKED: <reason>"
14. Otherwise, respond with "CONTINUE: <reasoning>" followed by a tool call in JSON format:
   {"name": "tool_name", "arguments": {...}}
15. Keep each step small and deterministic. Prefer one command per step.

Your response should be clear and actionable.`;

}
