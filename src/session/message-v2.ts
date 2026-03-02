import { z } from "zod";

export const messageRoleV2Schema = z.enum(["assistant", "system", "tool", "user"]);
export type MessageRoleV2 = z.infer<typeof messageRoleV2Schema>;

const basePartSchema = z.object({
  id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const textPartSchema = basePartSchema.extend({
  kind: z.literal("text"),
  text: z.string(),
});

export const reasoningPartSchema = basePartSchema.extend({
  kind: z.literal("reasoning"),
  text: z.string(),
});

export const toolCallPartSchema = basePartSchema.extend({
  kind: z.literal("tool_call"),
  name: z.string().min(1),
  toolCallId: z.string().min(1),
  arguments: z.unknown(),
});

export const toolResultPartSchema = basePartSchema.extend({
  kind: z.literal("tool_result"),
  name: z.string().min(1),
  toolCallId: z.string().min(1),
  artifacts: z.unknown().optional(),
  error: z.string().optional(),
  output: z.string(),
  success: z.boolean(),
});

export const patchPartSchema = basePartSchema.extend({
  kind: z.literal("patch"),
  files: z.array(z.string().min(1)),
});

export const stepStartPartSchema = basePartSchema.extend({
  kind: z.literal("step_start"),
  step: z.number().int().nonnegative(),
  stepId: z.string().min(1),
  title: z.string().optional(),
});

export const stepFinishPartSchema = basePartSchema.extend({
  kind: z.literal("step_finish"),
  step: z.number().int().nonnegative(),
  stepId: z.string().min(1),
  status: z.enum(["cancelled", "error", "success"]),
});

export const messagePartV2Schema = z.discriminatedUnion("kind", [
  patchPartSchema,
  reasoningPartSchema,
  stepFinishPartSchema,
  stepStartPartSchema,
  textPartSchema,
  toolCallPartSchema,
  toolResultPartSchema,
]);

export type MessagePartV2 = z.infer<typeof messagePartV2Schema>;

export const messageV2Schema = z.object({
  createdAt: z.string().min(1),
  id: z.string().min(1),
  parts: z.array(messagePartV2Schema),
  role: messageRoleV2Schema,
});

export type MessageV2 = z.infer<typeof messageV2Schema>;
