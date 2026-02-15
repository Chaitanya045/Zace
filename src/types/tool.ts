import { z } from "zod";

export const toolCallSchema = z.object({
  arguments: z.record(z.string(), z.unknown()),
  name: z.string().min(1),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export const toolResultArtifactsSchema = z.object({
  combinedPath: z.string().optional(),
  outputLimitChars: z.number().int().positive().optional(),
  stderrPath: z.string().optional(),
  stderrTruncated: z.boolean().optional(),
  stdoutPath: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
});

export const toolResultSchema = z.object({
  artifacts: toolResultArtifactsSchema.optional(),
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
