export interface SystemPromptContext {
  availableTools?: string[];
  currentDirectory?: string;
  maxSteps?: number;
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

You are not a chatbot. You are an autonomous coding agent operating in a local codebase.`;

export function buildSystemPrompt(context?: SystemPromptContext): string {
  let prompt = BASE_SYSTEM_PROMPT;

  if (context?.availableTools && context.availableTools.length > 0) {
    prompt += `\n\nAVAILABLE TOOLS:\n${context.availableTools.map((tool) => `- ${tool}`).join("\n")}`;
  }

  if (context?.currentDirectory) {
    prompt += `\n\nCURRENT DIRECTORY: ${context.currentDirectory}`;
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
