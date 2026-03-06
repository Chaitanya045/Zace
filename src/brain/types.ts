import { z } from "zod";

export const workingMemorySchema = z.object({
  activePlanStepId: z.nullable(z.string().min(1)),
  currentStep: z.nullable(z.string().min(1)),
  goal: z.nullable(z.string().min(1)),
  lastUpdatedAt: z.nullable(z.string()),
  recentDecisions: z.array(z.string()),
  relevantFiles: z.array(z.string()),
  sessionId: z.nullable(z.string().min(1)),
});

export const plannerStepStatusSchema = z.enum(["completed", "in_progress", "pending"]);

export const plannerStepSchema = z.object({
  id: z.string().min(1),
  relevantFiles: z.array(z.string()),
  status: plannerStepStatusSchema,
  title: z.string().min(1),
});

export const currentPlanSchema = z.object({
  currentStepId: z.nullable(z.string().min(1)),
  goal: z.nullable(z.string().min(1)),
  steps: z.array(plannerStepSchema),
  updatedAt: z.nullable(z.string()),
});

export const completedTaskRecordSchema = z.object({
  completedAt: z.nullable(z.string()),
  files: z.array(z.string()),
  goal: z.nullable(z.string().min(1)),
  stepId: z.string().min(1),
  title: z.string().min(1),
});

export const completedTasksSchema = z.array(completedTaskRecordSchema);

export const memoryGraphNodeTypeSchema = z.enum([
  "artifact",
  "bug",
  "concept",
  "decision",
  "feature",
  "file",
  "function",
  "session",
]);

export const memoryGraphNodeSchema = z.object({
  description: z.optional(z.string()),
  filePath: z.optional(z.string()),
  id: z.string().min(1),
  label: z.string().min(1),
  sessionId: z.optional(z.string().min(1)),
  type: memoryGraphNodeTypeSchema,
  updatedAt: z.nullable(z.string()),
});

export const memoryGraphNodesSchema = z.array(memoryGraphNodeSchema);

export const memoryGraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.string().min(1),
  updatedAt: z.nullable(z.string()),
  weight: z.number().min(0),
});

export const memoryGraphEdgesSchema = z.array(memoryGraphEdgeSchema);

export const fileImportanceSchema = z.record(z.string(), z.number().min(0).max(1));

export type CompletedTaskRecord = z.infer<typeof completedTaskRecordSchema>;
export type CurrentPlan = z.infer<typeof currentPlanSchema>;
export type FileImportanceMap = z.infer<typeof fileImportanceSchema>;
export type MemoryGraphEdge = z.infer<typeof memoryGraphEdgeSchema>;
export type MemoryGraphNode = z.infer<typeof memoryGraphNodeSchema>;
export type PlannerStep = z.infer<typeof plannerStepSchema>;
export type PlannerStepStatus = z.infer<typeof plannerStepStatusSchema>;
export type WorkingMemory = z.infer<typeof workingMemorySchema>;

export function createInitialWorkingMemory(): WorkingMemory {
  return {
    activePlanStepId: null,
    currentStep: null,
    goal: null,
    lastUpdatedAt: null,
    recentDecisions: [],
    relevantFiles: [],
    sessionId: null,
  };
}

export function createInitialCurrentPlan(): CurrentPlan {
  return {
    currentStepId: null,
    goal: null,
    steps: [],
    updatedAt: null,
  };
}
