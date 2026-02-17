import { env, type ExecutorAnalysisMode } from "../config/env";

export type AgentConfig = {
  commandAllowPatterns: string[];
  commandDenyPatterns: string[];
  compactionEnabled: boolean;
  compactionPreserveRecentMessages: number;
  compactionTriggerRatio: number;
  contextWindowTokens?: number;
  executorAnalysis: ExecutorAnalysisMode;
  lspEnabled: boolean;
  lspMaxDiagnosticsPerFile: number;
  lspMaxFilesInOutput: number;
  lspServerConfigPath: string;
  lspWaitForDiagnosticsMs: number;
  llmApiKey: string;
  llmModel: string;
  llmProvider: "openrouter";
  maxSteps: number;
  requireRiskyConfirmation: boolean;
  riskyConfirmationToken: string;
  stream: boolean;
  verbose: boolean;
};

export function getAgentConfig(): AgentConfig {
  return {
    commandAllowPatterns: env.AGENT_COMMAND_ALLOW_PATTERNS,
    commandDenyPatterns: env.AGENT_COMMAND_DENY_PATTERNS,
    compactionEnabled: env.AGENT_COMPACTION_ENABLED,
    compactionPreserveRecentMessages: env.AGENT_COMPACTION_PRESERVE_RECENT_MESSAGES,
    compactionTriggerRatio: env.AGENT_COMPACTION_TRIGGER_RATIO,
    contextWindowTokens: env.AGENT_CONTEXT_WINDOW_TOKENS,
    executorAnalysis: env.AGENT_EXECUTOR_ANALYSIS,
    llmApiKey: env.OPENROUTER_API_KEY,
    llmModel: env.OPENROUTER_MODEL,
    llmProvider: env.LLM_PROVIDER,
    lspEnabled: env.AGENT_LSP_ENABLED,
    lspMaxDiagnosticsPerFile: env.AGENT_LSP_MAX_DIAGNOSTICS_PER_FILE,
    lspMaxFilesInOutput: env.AGENT_LSP_MAX_FILES_IN_OUTPUT,
    lspServerConfigPath: env.AGENT_LSP_SERVER_CONFIG_PATH,
    lspWaitForDiagnosticsMs: env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS,
    maxSteps: env.AGENT_MAX_STEPS,
    requireRiskyConfirmation: env.AGENT_REQUIRE_RISKY_CONFIRMATION,
    riskyConfirmationToken: env.AGENT_RISKY_CONFIRMATION_TOKEN,
    stream: env.AGENT_STREAM,
    verbose: env.AGENT_VERBOSE,
  };
}
