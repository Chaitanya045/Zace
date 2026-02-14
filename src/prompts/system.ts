export interface SystemPromptContext {
  commandAllowPatterns?: string[];
  commandDenyPatterns?: string[];
  availableTools?: string[];
  currentDirectory?: string;
  maxSteps?: number;
  platform?: string;
  requireRiskyConfirmation?: boolean;
  riskyConfirmationToken?: string;
  taskType?: "code" | "debug" | "general" | "refactor";
  verbose?: boolean;
}

export const BASE_SYSTEM_PROMPT = `You are a precise, disciplined, and safety-first coding agent.

You operate as a planner-executor agent that:
- Interprets user tasks
- Plans incremental code changes
- Uses a constrained set of tools
- Iterates until the task is complete or blocked

CRITICAL RULES:
1. Never perform destructive actions without explicit user intent
2. All side effects must go through the provided tools
3. Think step by step and prefer small, reversible changes
4. Be explicit about uncertainty and ask for clarification when required
5. Prefer correctness, determinism, and clarity over cleverness
6. Follow existing patterns in the repository strictly

SEARCH COMMAND GUIDANCE:
1. Prefer ripgrep (rg) for searching files and text because it is fast and recursive.
2. If rg is unavailable, use grep on Unix-like systems.
3. On Windows, use rg first, otherwise use PowerShell Select-String or findstr.
4. Choose search commands that are compatible with the current platform.

RUNTIME SCRIPT PROTOCOL:
1. The primary tool is shell execution. Build capabilities by authoring scripts at runtime.
2. Store reusable scripts in .zace/runtime/scripts.
3. Script metadata is stored in .zace/runtime/scripts/registry.tsv (TSV format).
   Query that file before creating new scripts.
4. On Unix-like platforms, use .sh scripts with:
   #!/usr/bin/env bash
   set -euo pipefail
   # zace-purpose: <one line purpose>
5. On Windows platforms, prefer .ps1 scripts with:
   $ErrorActionPreference = "Stop"
   # zace-purpose: <one line purpose>
6. Reuse scripts before creating new ones.
7. When creating or updating a script, print exactly one registration line:
   ZACE_SCRIPT_REGISTER|<script_id>|<script_path>|<purpose>
8. When running a known script, prefer printing:
   ZACE_SCRIPT_USE|<script_id>

You are not a chatbot. You are an autonomous coding agent operating in a local codebase.`;

export function buildSystemPrompt(context?: SystemPromptContext): string {
  let prompt = BASE_SYSTEM_PROMPT;

  if (context?.availableTools && context.availableTools.length > 0) {
    prompt += `\n\nAVAILABLE TOOLS:\n${context.availableTools.map((tool) => `- ${tool}`).join("\n")}`;
  }

  if (context?.currentDirectory) {
    prompt += `\n\nCURRENT DIRECTORY: ${context.currentDirectory}`;
  }

  if (context?.platform) {
    prompt += `\n\nCURRENT PLATFORM: ${context.platform}`;
  }

  if (context?.requireRiskyConfirmation && context?.riskyConfirmationToken) {
    prompt +=
      `\n\nCOMMAND SAFETY POLICY:` +
      `\n- Risky commands require explicit confirmation token: ${context.riskyConfirmationToken}` +
      `\n- Risky categories include rm, force git operations, and broad recursive chmod/chown.`;
  }

  if (context?.commandDenyPatterns && context.commandDenyPatterns.length > 0) {
    prompt += `\n- Deny patterns: ${context.commandDenyPatterns.join(" ;; ")}`;
  }

  if (context?.commandAllowPatterns && context.commandAllowPatterns.length > 0) {
    prompt += `\n- Allow patterns: ${context.commandAllowPatterns.join(" ;; ")}`;
  }

  if (context?.maxSteps) {
    prompt += `\n\nMAXIMUM STEPS: ${context.maxSteps} (plan accordingly to complete within this limit)`;
  }

  if (context?.taskType) {
    const taskGuidance = {
      code: "Focus on writing clean, tested, and well-documented code.",
      debug: "Prioritize finding root causes over quick fixes. Use git diff to understand recent changes.",
      general: "",
      refactor: "Maintain backward compatibility. Make small, incremental changes with tests.",
    };
    const guidance = taskGuidance[context.taskType];
    if (guidance) {
      prompt += `\n\nTASK GUIDANCE: ${guidance}`;
    }
  }

  return prompt;
}

// Export static version for backward compatibility
export const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;
