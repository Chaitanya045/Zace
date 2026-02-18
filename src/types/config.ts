import {
  env,
  type CompletionValidationMode,
  type DocContextMode,
  type ExecutorAnalysisMode,
  type PlannerOutputMode,
} from "../config/env";

export type AgentConfig = {
  approvalMemoryEnabled: boolean;
  approvalRulesPath: string;
  commandAllowPatterns: string[];
  commandDenyPatterns: string[];
  compactionEnabled: boolean;
  compactionPreserveRecentMessages: number;
  compactionTriggerRatio: number;
  completionRequireDiscoveredGates: boolean;
  completionRequireLsp?: boolean;
  completionValidationMode: CompletionValidationMode;
  contextWindowTokens?: number;
  docContextMaxChars: number;
  docContextMaxFiles: number;
  docContextMode: DocContextMode;
  doomLoopThreshold: number;
  executorAnalysis: ExecutorAnalysisMode;
  gateDisallowMasking: boolean;
  lspAutoProvision: boolean;
  lspBootstrapBlockOnFailed: boolean;
  lspEnabled: boolean;
  lspMaxDiagnosticsPerFile: number;
  lspMaxFilesInOutput: number;
  lspProvisionMaxAttempts: number;
  lspServerConfigPath: string;
  lspWaitForDiagnosticsMs: number;
  llmCompatNormalizeToolRole: boolean;
  llmApiKey: string;
  llmModel: string;
  llmProvider: "openrouter";
  maxSteps: number;
  pendingActionMaxAgeMs: number;
  plannerMaxInvalidArtifactChars?: number;
  plannerOutputMode?: PlannerOutputMode;
  plannerParseMaxRepairs: number;
  plannerParseRetryOnFailure: boolean;
  plannerSchemaStrict?: boolean;
  requireRiskyConfirmation: boolean;
  riskyConfirmationToken: string;
  stagnationWindow: number;
  stream: boolean;
  verbose: boolean;
};

export function getAgentConfig(): AgentConfig {
  return {
    approvalMemoryEnabled: env.AGENT_APPROVAL_MEMORY_ENABLED,
    approvalRulesPath: env.AGENT_APPROVAL_RULES_PATH,
    commandAllowPatterns: env.AGENT_COMMAND_ALLOW_PATTERNS,
    commandDenyPatterns: env.AGENT_COMMAND_DENY_PATTERNS,
    compactionEnabled: env.AGENT_COMPACTION_ENABLED,
    compactionPreserveRecentMessages: env.AGENT_COMPACTION_PRESERVE_RECENT_MESSAGES,
    compactionTriggerRatio: env.AGENT_COMPACTION_TRIGGER_RATIO,
    completionRequireDiscoveredGates: env.AGENT_COMPLETION_REQUIRE_DISCOVERED_GATES,
    completionRequireLsp: env.AGENT_COMPLETION_REQUIRE_LSP,
    completionValidationMode: env.AGENT_COMPLETION_VALIDATION_MODE,
    contextWindowTokens: env.AGENT_CONTEXT_WINDOW_TOKENS,
    docContextMaxChars: env.AGENT_DOC_CONTEXT_MAX_CHARS,
    docContextMaxFiles: env.AGENT_DOC_CONTEXT_MAX_FILES,
    docContextMode: env.AGENT_DOC_CONTEXT_MODE,
    doomLoopThreshold: env.AGENT_DOOM_LOOP_THRESHOLD,
    executorAnalysis: env.AGENT_EXECUTOR_ANALYSIS,
    gateDisallowMasking: env.AGENT_GATE_DISALLOW_MASKING,
    llmApiKey: env.OPENROUTER_API_KEY,
    llmCompatNormalizeToolRole: env.AGENT_LLM_COMPAT_NORMALIZE_TOOL_ROLE,
    llmModel: env.OPENROUTER_MODEL,
    llmProvider: env.LLM_PROVIDER,
    lspAutoProvision: env.AGENT_LSP_AUTO_PROVISION,
    lspBootstrapBlockOnFailed: env.AGENT_LSP_BOOTSTRAP_BLOCK_ON_FAILED,
    lspEnabled: env.AGENT_LSP_ENABLED,
    lspMaxDiagnosticsPerFile: env.AGENT_LSP_MAX_DIAGNOSTICS_PER_FILE,
    lspMaxFilesInOutput: env.AGENT_LSP_MAX_FILES_IN_OUTPUT,
    lspProvisionMaxAttempts: env.AGENT_LSP_PROVISION_MAX_ATTEMPTS,
    lspServerConfigPath: env.AGENT_LSP_SERVER_CONFIG_PATH,
    lspWaitForDiagnosticsMs: env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS,
    maxSteps: env.AGENT_MAX_STEPS,
    pendingActionMaxAgeMs: env.AGENT_PENDING_ACTION_MAX_AGE_MS,
    plannerMaxInvalidArtifactChars: env.AGENT_PLANNER_MAX_INVALID_ARTIFACT_CHARS,
    plannerOutputMode: env.AGENT_PLANNER_OUTPUT_MODE,
    plannerParseMaxRepairs: env.AGENT_PLANNER_PARSE_MAX_REPAIRS,
    plannerParseRetryOnFailure: env.AGENT_PLANNER_PARSE_RETRY_ON_FAILURE,
    plannerSchemaStrict: env.AGENT_PLANNER_SCHEMA_STRICT,
    requireRiskyConfirmation: env.AGENT_REQUIRE_RISKY_CONFIRMATION,
    riskyConfirmationToken: env.AGENT_RISKY_CONFIRMATION_TOKEN,
    stagnationWindow: env.AGENT_STAGNATION_WINDOW,
    stream: env.AGENT_STREAM,
    verbose: env.AGENT_VERBOSE,
  };
}
