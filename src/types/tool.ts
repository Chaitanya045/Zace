import { z } from "zod";

export const toolCallSchema = z.object({
  arguments: z.record(z.string(), z.unknown()),
  name: z.string().min(1),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

const changedFilesSourceSchema = z.enum(["git_delta", "marker"]);
const progressSignalSchema = z.enum([
  "files_changed",
  "none",
  "output_changed",
  "success_without_changes",
]);
const shellLifecycleEventSchema = z.enum(["abort", "none", "timeout"]);

export const toolResultArtifactsSchema = z.object({
  aborted: z.boolean().optional(),
  changedFiles: z.array(z.string()).optional(),
  changedFilesSource: z.array(changedFilesSourceSchema).optional(),
  combinedPath: z.string().optional(),
  commandSignature: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  lifecycleEvent: shellLifecycleEventSchema.optional(),
  lspDiagnosticsFiles: z.array(z.string()).optional(),
  lspDiagnosticsIncluded: z.boolean().optional(),
  lspErrorCount: z.number().int().nonnegative().optional(),
  outputLimitChars: z.number().int().positive().optional(),
  progressSignal: progressSignalSchema.optional(),
  signal: z.string().optional(),
  stderrPath: z.string().optional(),
  stderrTruncated: z.boolean().optional(),
  stdoutPath: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
  timedOut: z.boolean().optional(),
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
