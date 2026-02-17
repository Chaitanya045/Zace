import {
  env,
  type CompletionValidationMode,
  type ExecutorAnalysisMode,
} from "../config/env";

export type AgentConfig = {
  approvalMemoryEnabled: boolean;
  approvalRulesPath: string;
  commandAllowPatterns: string[];
  commandDenyPatterns: string[];
  compactionEnabled: boolean;
  compactionPreserveRecentMessages: number;
  compactionTriggerRatio: number;
  completionValidationMode: CompletionValidationMode;
  contextWindowTokens?: number;
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
  llmApiKey: string;
  llmModel: string;
  llmProvider: "openrouter";
  maxSteps: number;
  pendingActionMaxAgeMs: number;
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
    completionValidationMode: env.AGENT_COMPLETION_VALIDATION_MODE,
    contextWindowTokens: env.AGENT_CONTEXT_WINDOW_TOKENS,
    doomLoopThreshold: env.AGENT_DOOM_LOOP_THRESHOLD,
    executorAnalysis: env.AGENT_EXECUTOR_ANALYSIS,
    gateDisallowMasking: env.AGENT_GATE_DISALLOW_MASKING,
    llmApiKey: env.OPENROUTER_API_KEY,
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
    requireRiskyConfirmation: env.AGENT_REQUIRE_RISKY_CONFIRMATION,
    riskyConfirmationToken: env.AGENT_RISKY_CONFIRMATION_TOKEN,
    stagnationWindow: env.AGENT_STAGNATION_WINDOW,
    stream: env.AGENT_STREAM,
    verbose: env.AGENT_VERBOSE,
  };
}
