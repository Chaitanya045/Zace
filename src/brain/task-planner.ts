import {
  createInitialCurrentPlan,
  type CompletedTaskRecord,
  type CurrentPlan,
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
