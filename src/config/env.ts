import { z } from "zod";

export const EXECUTOR_ANALYSIS_MODES = ["always", "never", "on_failure"] as const;

export type ExecutorAnalysisMode = (typeof EXECUTOR_ANALYSIS_MODES)[number];

export function isExecutorAnalysisMode(value: string): value is ExecutorAnalysisMode {
  return (EXECUTOR_ANALYSIS_MODES as readonly string[]).includes(value);
}

const commandPatternListSchema = z.string().default("").transform((value) =>
  value
    .split(";;")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
);

const envSchema = z.object({
  AGENT_COMMAND_ALLOW_PATTERNS: commandPatternListSchema,
  AGENT_COMMAND_ARTIFACTS_DIR: z.string().min(1),
  AGENT_COMMAND_DENY_PATTERNS: commandPatternListSchema,
  AGENT_EXECUTOR_ANALYSIS: z.enum(EXECUTOR_ANALYSIS_MODES).default("on_failure"),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(10),
  AGENT_REQUIRE_RISKY_CONFIRMATION: z.coerce.boolean().default(true),
  AGENT_RISKY_CONFIRMATION_TOKEN: z.string().min(1).default("ZACE_APPROVE_RISKY"),
  AGENT_STREAM: z.coerce.boolean().default(false),
  AGENT_TOOL_OUTPUT_LIMIT_CHARS: z.coerce.number().int().positive(),
  AGENT_VERBOSE: z.coerce.boolean().default(false),
  LLM_PROVIDER: z.literal("openrouter"),

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
