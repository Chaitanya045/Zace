import { env, type ExecutorAnalysisMode } from "../config/env";

export type AgentConfig = {
  executorAnalysis: ExecutorAnalysisMode;
  maxSteps: number;
  stream: boolean;
  verbose: boolean;
  llmProvider: "openrouter";
  llmApiKey: string;
  llmModel: string;
};

export function getAgentConfig(): AgentConfig {
  return {
    executorAnalysis: env.AGENT_EXECUTOR_ANALYSIS,
    llmApiKey: env.OPENROUTER_API_KEY,
    llmModel: env.OPENROUTER_MODEL,
    llmProvider: env.LLM_PROVIDER,
    maxSteps: env.AGENT_MAX_STEPS,
    stream: env.AGENT_STREAM,
    verbose: env.AGENT_VERBOSE,
  };
}
