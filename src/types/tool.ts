import { z } from "zod";

export const toolCallSchema = z.object({
  arguments: z.record(z.string(), z.unknown()),
  name: z.string().min(1),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

const changedFilesSourceSchema = z.enum(["git_delta", "inferred_redirect", "marker"]);
const progressSignalSchema = z.enum([
  "files_changed",
  "none",
  "output_changed",
  "success_without_changes",
]);
const lspStatusSchema = z.enum([
  "diagnostics",
  "disabled",
  "failed",
  "no_active_server",
  "no_applicable_files",
  "no_changed_files",
  "no_errors",
]);
const shellLifecycleEventSchema = z.enum(["abort", "none", "timeout"]);
const retryCategorySchema = z.enum(["non_transient", "transient", "unknown"]);

export const toolResultArtifactsSchema = z.object({
  aborted: z.boolean().optional(),
  changedFiles: z.array(z.string()).optional(),
  changedFilesSource: z.array(changedFilesSourceSchema).optional(),
  combinedPath: z.string().optional(),
  commandSignature: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  lifecycleEvent: shellLifecycleEventSchema.optional(),
  lspConfigPath: z.string().optional(),
  lspDiagnosticsFiles: z.array(z.string()).optional(),
  lspDiagnosticsIncluded: z.boolean().optional(),
  lspErrorCount: z.number().int().nonnegative().optional(),
  lspProbeAttempted: z.boolean().optional(),
  lspProbeSucceeded: z.boolean().optional(),
  lspStatus: lspStatusSchema.optional(),
  lspStatusReason: z.string().optional(),
  outputLimitChars: z.number().int().positive().optional(),
  progressSignal: progressSignalSchema.optional(),
  retryCategory: retryCategorySchema.optional(),
  retrySuppressedReason: z.string().optional(),
  signal: z.string().optional(),
  stderrPath: z.string().optional(),
  stderrTruncated: z.boolean().optional(),
  stdoutPath: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  validationMaskingDetected: z.boolean().optional(),
  validationMaskingReason: z.string().optional(),
  writeRegressionDetected: z.boolean().optional(),
  writeRegressionReason: z.string().optional(),
});

export const toolResultSchema = z.object({
  artifacts: toolResultArtifactsSchema.optional(),
  error: z.string().optional(),
  output: z.string(),
  success: z.boolean(),
});

export type ToolResult = z.infer<typeof toolResultSchema>;

export type AbortSignalLike = {
  aborted: boolean;
  addEventListener: (
    type: "abort",
    listener: () => void,
    options?: {
      once?: boolean;
    }
  ) => void;
  removeEventListener: (type: "abort", listener: () => void) => void;
};

export type ToolExecutionContext = {
  abortSignal?: AbortSignalLike;
};

export interface Tool {
  description: string;
  execute: (_args: unknown, _context?: ToolExecutionContext) => Promise<ToolResult>;
  name: string;
  parameters: z.ZodSchema<unknown>;
}
