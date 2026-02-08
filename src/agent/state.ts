import type { AgentContext, AgentState, AgentStep, ScriptMetadata } from "../types/agent";

export function createInitialContext(task: string, maxSteps: number): AgentContext {
  return {
    currentStep: 0,
    fileSummaries: new Map(),
    maxSteps,
    scriptCatalog: new Map(),
    steps: [],
    task,
  };
}

export function addStep(context: AgentContext, step: AgentStep): AgentContext {
  return {
    ...context,
    currentStep: step.step,
    steps: [...context.steps, step],
  };
}

export function updateFileSummaries(
  context: AgentContext,
  summaries: Map<string, string>
): AgentContext {
  return {
    ...context,
    fileSummaries: new Map([...context.fileSummaries, ...summaries]),
  };
}

export function updateScriptCatalog(
  context: AgentContext,
  scriptCatalog: Map<string, ScriptMetadata>
): AgentContext {
  return {
    ...context,
    scriptCatalog,
  };
}

export function transitionState(context: AgentContext, newState: AgentState): AgentContext {
  const lastStep = context.steps[context.steps.length - 1];
  if (lastStep) {
    return {
      ...context,
      steps: [
        ...context.steps.slice(0, -1),
        {
          ...lastStep,
          state: newState,
        },
      ],
    };
  }
  return context;
}
