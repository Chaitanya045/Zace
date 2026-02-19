import { Command } from "commander";

import type { AgentConfig } from "../types/config";

import { EXECUTOR_ANALYSIS_MODES, isExecutorAnalysisMode } from "../config/env";
import { LlmClient } from "../llm/client";
import { getSessionFilePath } from "../tools/session";
import { getAgentConfig } from "../types/config";
import { isInteractiveTerminal, runChatUi } from "../ui";
import { runPlainChatMode } from "../ui/plain-fallback";
import { initializeLogger } from "../utils/logger";
import { resolveOrCreateSessionId } from "./chat-session";

type CliOptions = {
  executorAnalysis?: string;
  session?: string;
  stream?: boolean;
  verbose?: boolean;
};

function applyCommonOptions(command: Command): Command {
  return command
    .option(
      "--executor-analysis <mode>",
      "Executor LLM analysis mode: always | on_failure | never"
    )
    .option("--session <id>", "Persist and resume conversation from a session id")
    .option("-s, --stream", "Stream LLM output as it is generated")
    .option("-v, --verbose", "Verbose output");
}

function applyRuntimeOptions(config: AgentConfig, options: CliOptions): void {
  if (options.executorAnalysis) {
    if (!isExecutorAnalysisMode(options.executorAnalysis)) {
      throw new Error(
        `Invalid --executor-analysis value: ${options.executorAnalysis}. Expected: ${EXECUTOR_ANALYSIS_MODES.join(" | ")}`
      );
    }
    config.executorAnalysis = options.executorAnalysis;
  }

  if (options.stream) {
    config.stream = true;
  }

  if (options.verbose) {
    config.verbose = true;
  }
}

async function runChatCommand(options: CliOptions): Promise<void> {
  const config = getAgentConfig();
  applyRuntimeOptions(config, options);
  initializeLogger(config);

  const client = new LlmClient(config);
  const sessionId = resolveOrCreateSessionId(options.session);
  const sessionPath = getSessionFilePath(sessionId);

  console.log(`\n💬 Zace chat`);
  console.log(`Session: ${sessionId} (${sessionPath})\n`);

  if (isInteractiveTerminal()) {
    await runChatUi({
      client,
      config,
      sessionId,
    });
    return;
  }

  await runPlainChatMode(client, config, sessionId);
}

export function runCli(): void {
  const program = new Command();

  program.name("zace").description("CLI coding agent").version("0.1.0");

  applyCommonOptions(program)
    .description("Start interactive chat mode")
    .action(async (options: CliOptions) => {
      try {
        await runChatCommand(options);
        process.exit(0);
      } catch (error) {
        console.error(
          "\n❌ Fatal error:",
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof Error && error.stack) {
          console.error(error.stack);
        }
        process.exit(1);
      }
    });

  program.parse();
}
