import type { PlannerPlanState } from "../agent/planner/schema";

import { fsReadFile, fsWriteFile } from "../tools/system/fs";
import { getBrainPaths } from "./paths";
import {
  completedTasksSchema,
  createInitialCurrentPlan,
  currentPlanSchema,
  type CompletedTaskRecord,
  type CurrentPlan,
  type PlannerStep,
} from "./types";

export function createInitialCompletedTasks(): CompletedTaskRecord[] {
  return [];
}

export function createInitialPlannerState(): {
  completedTasks: CompletedTaskRecord[];
  currentPlan: CurrentPlan;
} {
  return {
    completedTasks: createInitialCompletedTasks(),
    currentPlan: createInitialCurrentPlan(),
  };
}

export function serializeCompletedTasks(tasks: CompletedTaskRecord[]): string {
  return `${JSON.stringify(tasks, null, 2)}\n`;
}

export function serializeCurrentPlan(plan: CurrentPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function buildCompletedTaskKey(stepId: string, goal: null | string): string {
  return `${goal ?? ""}::${stepId}`;
}

function deriveCurrentStepId(
  preferredStepId: null | string,
  steps: PlannerStep[]
): null | string {
  if (preferredStepId && steps.some((step) => step.id === preferredStepId)) {
    return preferredStepId;
  }

  return (
    steps.find((step) => step.status === "in_progress")?.id ??
    steps.find((step) => step.status === "pending")?.id ??
    null
  );
}

async function parseJsonFile<T>(
  pathValue: string,
  safeParse: (value: unknown) => {
    data?: T;
    success: boolean;
  },
  fallback: T
): Promise<T> {
  try {
    const content = await fsReadFile(pathValue, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const validated = safeParse(parsed);
    return validated.success && validated.data !== undefined ? validated.data : fallback;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    return fallback;
  }
}

function normalizePlannerPlanState(input: PlannerPlanState): CurrentPlan {
  const normalizedSteps: PlannerStep[] = input.steps.map((step) => ({
    id: step.id,
    relevantFiles: Array.from(new Set(step.relevantFiles ?? [])),
    status: step.status,
    title: step.title,
  }));

  return {
    currentStepId: deriveCurrentStepId(input.currentStepId, normalizedSteps),
    goal: input.goal,
    steps: normalizedSteps,
    updatedAt: null,
  };
}

function archiveCompletedSteps(input: {
  completedAt: string;
  existingCompletedTasks: CompletedTaskRecord[];
  goal: null | string;
  steps: PlannerStep[];
}): {
  archivedTasks: CompletedTaskRecord[];
  remainingSteps: PlannerStep[];
} {
  const completedTaskKeys = new Set(
    input.existingCompletedTasks.map((task) => buildCompletedTaskKey(task.stepId, task.goal))
  );
  const archivedTasks: CompletedTaskRecord[] = [];
  const remainingSteps = input.steps.filter((step) => {
    if (step.status !== "completed") {
      return true;
    }

    const taskKey = buildCompletedTaskKey(step.id, input.goal);
    if (!completedTaskKeys.has(taskKey)) {
      completedTaskKeys.add(taskKey);
      archivedTasks.push({
        completedAt: input.completedAt,
        files: step.relevantFiles,
        goal: input.goal,
        stepId: step.id,
        title: step.title,
      });
    }

    return false;
  });

  return {
    archivedTasks,
    remainingSteps,
  };
}

function markPlanComplete(plan: CurrentPlan): CurrentPlan {
  return {
    ...plan,
    currentStepId: null,
    goal: plan.goal,
    steps: plan.steps.map((step) => ({
      ...step,
      status: "completed",
    })),
  };
}

export async function persistPlannerState(input: {
  action: "ask_user" | "blocked" | "complete" | "continue";
  planState?: PlannerPlanState;
  workspaceRoot?: string;
}): Promise<{
  completedTasks: CompletedTaskRecord[];
  currentPlan: CurrentPlan;
}> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const existingCurrentPlan = await parseJsonFile(
    paths.currentPlanFile,
    (value) => currentPlanSchema.safeParse(value),
    createInitialCurrentPlan()
  );
  const existingCompletedTasks = await parseJsonFile(
    paths.completedTasksFile,
    (value) => completedTasksSchema.safeParse(value),
    createInitialCompletedTasks()
  );

  if (!input.planState && input.action !== "complete") {
    return {
      completedTasks: existingCompletedTasks,
      currentPlan: existingCurrentPlan,
    };
  }

  const now = new Date().toISOString();
  const nextPlanBase = input.planState
    ? normalizePlannerPlanState(input.planState)
    : existingCurrentPlan;
  const planForArchival = input.action === "complete"
    ? markPlanComplete(nextPlanBase)
    : nextPlanBase;
  const archival = archiveCompletedSteps({
    completedAt: now,
    existingCompletedTasks,
    goal: planForArchival.goal,
    steps: planForArchival.steps,
  });
  const nextCurrentPlan: CurrentPlan = {
    currentStepId: input.action === "complete"
      ? null
      : deriveCurrentStepId(planForArchival.currentStepId, archival.remainingSteps),
    goal: input.action === "complete"
      ? null
      : planForArchival.goal,
    steps: archival.remainingSteps,
    updatedAt: now,
  };
  const nextCompletedTasks = [...existingCompletedTasks, ...archival.archivedTasks];

  await fsWriteFile(paths.currentPlanFile, serializeCurrentPlan(nextCurrentPlan), "utf8");
  await fsWriteFile(paths.completedTasksFile, serializeCompletedTasks(nextCompletedTasks), "utf8");

  return {
    completedTasks: nextCompletedTasks,
    currentPlan: nextCurrentPlan,
  };
}
