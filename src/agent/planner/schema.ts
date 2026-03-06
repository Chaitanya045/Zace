import { z } from "zod";

import { searchSessionMessagesSchema, writeSessionMessageSchema } from "../../tools/session-history";
import { executeCommandSchema } from "../../tools/shell";

const bashPlannerToolCallSchema = z.object({
  arguments: executeCommandSchema,
  name: z.literal("bash"),
}).strict();

const executeCommandPlannerToolCallSchema = z.object({
  arguments: executeCommandSchema,
  name: z.literal("execute_command"),
}).strict();

const searchSessionMessagesPlannerToolCallSchema = z.object({
  arguments: searchSessionMessagesSchema,
  name: z.literal("search_session_messages"),
}).strict();

const writeSessionMessagePlannerToolCallSchema = z.object({
  arguments: writeSessionMessageSchema,
  name: z.literal("write_session_message"),
}).strict();

export const plannerToolCallSchema = z.discriminatedUnion("name", [
  bashPlannerToolCallSchema,
  executeCommandPlannerToolCallSchema,
  searchSessionMessagesPlannerToolCallSchema,
  writeSessionMessagePlannerToolCallSchema,
]);

export const plannerPlanStepSchema = z.object({
  id: z.string().min(1),
  relevantFiles: z.array(z.string().min(1)).optional(),
  status: z.enum(["completed", "in_progress", "pending"]),
  title: z.string().min(1),
}).strict();

export const plannerPlanStateSchema = z.object({
  currentStepId: z.nullable(z.string().min(1)),
  goal: z.nullable(z.string().min(1)),
  steps: z.array(plannerPlanStepSchema),
}).strict();

export const plannerCompleteResponseSchema = z.object({
  action: z.literal("complete"),
  gates: z.union([z.array(z.string().min(1)), z.literal("none")]).optional(),
  planState: plannerPlanStateSchema.optional(),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

export const plannerContinueResponseSchema = z.object({
  action: z.literal("continue"),
  planState: plannerPlanStateSchema.optional(),
  reasoning: z.string().min(1),
  toolCall: plannerToolCallSchema,
});

export const plannerAskUserResponseSchema = z.object({
  action: z.literal("ask_user"),
  planState: plannerPlanStateSchema.optional(),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

export const plannerBlockedResponseSchema = z.object({
  action: z.literal("blocked"),
  planState: plannerPlanStateSchema.optional(),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

export const plannerResponseSchema = z.union([
  plannerContinueResponseSchema,
  plannerCompleteResponseSchema,
  plannerAskUserResponseSchema,
  plannerBlockedResponseSchema,
]);

export type PlannerPlanState = z.infer<typeof plannerPlanStateSchema>;
export type PlannerStructuredResponse = z.infer<typeof plannerResponseSchema>;
