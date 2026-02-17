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
7. For execute_command, you may set:
   maxRetries (bounded retry attempts), retryMaxDelayMs (max delay cap), outputLimitChars (stdout/stderr truncation limit).
8. When older conversation context is needed, use search_session_messages before asking the user to repeat details.
9. Use write_session_message to persist durable notes/checkpoints that may be useful after compaction.
10. Before any write/create/edit command, inspect the repository with read-only commands to infer project language and layout.
11. Align file extensions with inferred repo stack unless the user explicitly requests another language.
12. If user clarification is required, choose action "ask_user" with one clear question.
    - "reasoning" is internal summary for agent memory.
    - "userMessage" is the exact text shown to the user and should be concise, direct, and human-friendly.
13. Destructive shell commands require explicit user confirmation before execution.
14. Do not choose "complete" unless completion gates pass.
15. If completion gates are missing and validation should run, include project-specific commands in complete response.
16. Keep each step small and deterministic. Prefer one command per step.
17. For greetings or non-actionable messages, choose "ask_user" and ask what concrete task to perform.
18. If context was compacted or details may be old, prefer search_session_messages before asking the user to repeat information.

RESPONSE FORMAT:
- Return strict JSON only. No markdown, no prose outside JSON.
- Use exactly one action per response:
  - continue: must include toolCall
  - ask_user: must include reasoning
  - blocked: must include reasoning
  - complete: must include reasoning and optional gates

JSON SCHEMA:
{
  "action": "continue" | "ask_user" | "blocked" | "complete",
  "reasoning": "short explicit reasoning",
  "userMessage": "user-facing text shown in chat",
  "toolCall": {
    "name": "tool_name",
    "arguments": {}
  },
  "gates": "none" | ["command one", "command two"]
}

Notes:
- Provide "toolCall" only when action is "continue".
- Provide "gates" only when action is "complete".
- For "ask_user", always provide "userMessage" as a direct question.
- If no validation gates are required, set "gates": "none".`;

}
