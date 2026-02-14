import { env, type ExecutorAnalysisMode } from "../config/env";

export type AgentConfig = {
  commandAllowPatterns: string[];
  commandDenyPatterns: string[];
  executorAnalysis: ExecutorAnalysisMode;
  maxSteps: number;
  llmProvider: "openrouter";
  llmApiKey: string;
  llmModel: string;
  requireRiskyConfirmation: boolean;
  riskyConfirmationToken: string;
  stream: boolean;
  verbose: boolean;
};

export function getAgentConfig(): AgentConfig {
  return {
    commandAllowPatterns: env.AGENT_COMMAND_ALLOW_PATTERNS,
    commandDenyPatterns: env.AGENT_COMMAND_DENY_PATTERNS,
    executorAnalysis: env.AGENT_EXECUTOR_ANALYSIS,
    llmApiKey: env.OPENROUTER_API_KEY,
    llmModel: env.OPENROUTER_MODEL,
    llmProvider: env.LLM_PROVIDER,
    maxSteps: env.AGENT_MAX_STEPS,
    requireRiskyConfirmation: env.AGENT_REQUIRE_RISKY_CONFIRMATION,
    riskyConfirmationToken: env.AGENT_RISKY_CONFIRMATION_TOKEN,
    stream: env.AGENT_STREAM,
    verbose: env.AGENT_VERBOSE,
  };
}
