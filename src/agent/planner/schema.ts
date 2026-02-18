import { z } from "zod";

const sessionMessageRoleSchema = z.enum(["assistant", "system", "tool", "user"]);

const executeCommandPlannerToolCallSchema = z.object({
  arguments: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    outputLimitChars: z.number().int().positive().optional(),
    retryMaxDelayMs: z.number().int().nonnegative().optional(),
    timeout: z.number().int().positive().optional(),
  }).strict(),
  name: z.literal("execute_command"),
}).strict();

const searchSessionMessagesPlannerToolCallSchema = z.object({
  arguments: z.object({
    caseSensitive: z.boolean().optional(),
    limit: z.number().int().positive().max(200).optional(),
    query: z.string().optional(),
    regex: z.boolean().optional(),
    role: sessionMessageRoleSchema.optional(),
    sessionId: z.string().min(1),
  }).strict(),
  name: z.literal("search_session_messages"),
}).strict();

const writeSessionMessagePlannerToolCallSchema = z.object({
  arguments: z.object({
    content: z.string().min(1),
    role: sessionMessageRoleSchema.optional(),
    sessionId: z.string().min(1),
    timestamp: z.string().optional(),
  }).strict(),
  name: z.literal("write_session_message"),
}).strict();

export const plannerToolCallSchema = z.discriminatedUnion("name", [
  executeCommandPlannerToolCallSchema,
  searchSessionMessagesPlannerToolCallSchema,
  writeSessionMessagePlannerToolCallSchema,
]);

export const plannerCompleteResponseSchema = z.object({
  action: z.literal("complete"),
  gates: z.union([z.array(z.string().min(1)), z.literal("none")]).optional(),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

export const plannerContinueResponseSchema = z.object({
  action: z.literal("continue"),
  reasoning: z.string().min(1),
  toolCall: plannerToolCallSchema,
});

export const plannerAskUserResponseSchema = z.object({
  action: z.literal("ask_user"),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

export const plannerBlockedResponseSchema = z.object({
  action: z.literal("blocked"),
  reasoning: z.string().min(1),
  userMessage: z.string().min(1).optional(),
});

export const plannerResponseSchema = z.union([
  plannerContinueResponseSchema,
  plannerCompleteResponseSchema,
  plannerAskUserResponseSchema,
  plannerBlockedResponseSchema,
]);

export type PlannerStructuredResponse = z.infer<typeof plannerResponseSchema>;
