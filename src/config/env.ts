import { z } from "zod";

export const EXECUTOR_ANALYSIS_MODES = ["always", "never", "on_failure"] as const;

export type ExecutorAnalysisMode = (typeof EXECUTOR_ANALYSIS_MODES)[number];

export function isExecutorAnalysisMode(value: string): value is ExecutorAnalysisMode {
  return (EXECUTOR_ANALYSIS_MODES as readonly string[]).includes(value);
}

export const COMPLETION_VALIDATION_MODES = ["balanced", "llm_only", "strict"] as const;

export type CompletionValidationMode = (typeof COMPLETION_VALIDATION_MODES)[number];

export function isCompletionValidationMode(value: string): value is CompletionValidationMode {
  return (COMPLETION_VALIDATION_MODES as readonly string[]).includes(value);
}

export const DOC_CONTEXT_MODES = ["broad", "off", "targeted"] as const;

export type DocContextMode = (typeof DOC_CONTEXT_MODES)[number];

export function isDocContextMode(value: string): value is DocContextMode {
  return (DOC_CONTEXT_MODES as readonly string[]).includes(value);
}

export const PLANNER_OUTPUT_MODES = ["auto", "prompt_only", "schema_strict"] as const;

export type PlannerOutputMode = (typeof PLANNER_OUTPUT_MODES)[number];

export function isPlannerOutputMode(value: string): value is PlannerOutputMode {
  return (PLANNER_OUTPUT_MODES as readonly string[]).includes(value);
}

const commandPatternListSchema = z.string().default("").transform((value) =>
  value
    .split(";;")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
);

const envSchema = z.object({
  AGENT_APPROVAL_MEMORY_ENABLED: z.coerce.boolean().default(true),
  AGENT_APPROVAL_RULES_PATH: z.string().min(1).default(".zace/runtime/policy/approvals.json"),
  AGENT_COMMAND_ALLOW_PATTERNS: commandPatternListSchema,
  AGENT_COMMAND_ARTIFACTS_DIR: z.string().min(1),
  AGENT_COMMAND_DENY_PATTERNS: commandPatternListSchema,
  AGENT_COMPACTION_ENABLED: z.coerce.boolean().default(true),
  AGENT_COMPACTION_PRESERVE_RECENT_MESSAGES: z.coerce.number().int().min(1).default(12),
  AGENT_COMPACTION_TRIGGER_RATIO: z.coerce.number().gt(0).lte(1).default(0.8),
  AGENT_COMPLETION_REQUIRE_DISCOVERED_GATES: z.coerce.boolean().default(true),
  AGENT_COMPLETION_REQUIRE_LSP: z.coerce.boolean().default(false),
  AGENT_COMPLETION_VALIDATION_MODE: z.enum(COMPLETION_VALIDATION_MODES).default("strict"),
  AGENT_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().optional(),
  AGENT_DOC_CONTEXT_MAX_CHARS: z.coerce.number().int().positive().default(6000),
  AGENT_DOC_CONTEXT_MAX_FILES: z.coerce.number().int().positive().default(3),
  AGENT_DOC_CONTEXT_MODE: z.enum(DOC_CONTEXT_MODES).default("targeted"),
  AGENT_DOOM_LOOP_THRESHOLD: z.coerce.number().int().min(2).default(3),
  AGENT_EXECUTOR_ANALYSIS: z.enum(EXECUTOR_ANALYSIS_MODES).default("on_failure"),
  AGENT_GATE_DISALLOW_MASKING: z.coerce.boolean().default(true),
  AGENT_LLM_COMPAT_NORMALIZE_TOOL_ROLE: z.coerce.boolean().default(true),
  AGENT_LSP_AUTO_PROVISION: z.coerce.boolean().default(true),
  AGENT_LSP_BOOTSTRAP_BLOCK_ON_FAILED: z.coerce.boolean().default(true),
  AGENT_LSP_ENABLED: z.coerce.boolean().default(true),
  AGENT_LSP_MAX_DIAGNOSTICS_PER_FILE: z.coerce.number().int().positive().default(20),
  AGENT_LSP_MAX_FILES_IN_OUTPUT: z.coerce.number().int().positive().default(5),
  AGENT_LSP_PROVISION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  AGENT_LSP_SERVER_CONFIG_PATH: z.string().min(1).default(".zace/runtime/lsp/servers.json"),
  AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS: z.coerce.number().int().positive().default(3000),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(10),
  AGENT_PENDING_ACTION_MAX_AGE_MS: z.coerce.number().int().positive().default(3_600_000),
  AGENT_PLANNER_MAX_INVALID_ARTIFACT_CHARS: z.coerce.number().int().positive().default(4000),
  AGENT_PLANNER_OUTPUT_MODE: z.enum(PLANNER_OUTPUT_MODES).default("auto"),
  AGENT_PLANNER_PARSE_MAX_REPAIRS: z.coerce.number().int().nonnegative().default(2),
  AGENT_PLANNER_PARSE_RETRY_ON_FAILURE: z.coerce.boolean().default(true),
  AGENT_PLANNER_SCHEMA_STRICT: z.coerce.boolean().default(true),
  AGENT_REQUIRE_RISKY_CONFIRMATION: z.coerce.boolean().default(true),
  AGENT_RISKY_CONFIRMATION_TOKEN: z.string().min(1).default("ZACE_APPROVE_RISKY"),
  AGENT_STAGNATION_WINDOW: z.coerce.number().int().min(1).default(3),
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
