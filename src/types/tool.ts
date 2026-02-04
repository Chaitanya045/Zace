import { z } from "zod";

export const toolCallSchema = z.object({
  arguments: z.record(z.string(), z.unknown()),
  name: z.string().min(1),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export const toolResultSchema = z.object({
  error: z.string().optional(),
  output: z.string(),
  success: z.boolean(),
});

export type ToolResult = z.infer<typeof toolResultSchema>;

export interface Tool {
  description: string;
  execute: (_args: unknown) => Promise<ToolResult>;
  name: string;
  parameters: z.ZodSchema<unknown>;
}
