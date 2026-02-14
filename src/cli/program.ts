import { Command } from "commander";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runAgentLoop } from "../agent/loop";
import { EXECUTOR_ANALYSIS_MODES, isExecutorAnalysisMode } from "../config/env";
import { LlmClient } from "../llm/client";
import { getAgentConfig } from "../types/config";
import { initializeLogger } from "../utils/logger";

type CliOptions = {
  executorAnalysis?: string;
  stream?: boolean;
  verbose?: boolean;
};

type ChatTurn = {
  assistant: string;
  finalState: string;
  steps: number;
  user: string;
};

const MAX_CHAT_CONTEXT_TURNS = 6;

function applyCommonOptions(command: Command): Command {
  return command
    .option(
      "--executor-analysis <mode>",
      "Executor LLM analysis mode: always | on_failure | never"
    )
    .option("-s, --stream", "Stream LLM output as it is generated")
    .option("-v, --verbose", "Verbose output");
}

function applyRuntimeOptions(config: ReturnType<typeof getAgentConfig>, options: CliOptions): void {
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

function buildChatTask(turns: ChatTurn[], userInput: string): string {
  const recentTurns = turns.slice(-MAX_CHAT_CONTEXT_TURNS);
  if (recentTurns.length === 0) {
    return userInput;
  }

  const history = recentTurns
    .map(
      (turn, index) =>
        `Turn ${index + 1}\nUser: ${turn.user}\nAssistant: ${turn.assistant}\nState: ${turn.finalState}`
    )
    .join("\n\n");

  return `Continue this interactive conversation using the recent context.

RECENT CONVERSATION:
${history}

CURRENT USER MESSAGE:
${userInput}`;
}

function printChatStatus(turns: ChatTurn[]): void {
  const lastTurn = turns[turns.length - 1];

  console.log("\n📌 Chat status");
  console.log(`Turns: ${turns.length}`);
  if (!lastTurn) {
    console.log("Last result: none\n");
    return;
  }

  console.log(`Last state: ${lastTurn.finalState}`);
  console.log(`Last steps: ${lastTurn.steps}`);
  console.log(`Last response: ${lastTurn.assistant}\n`);
}

async function runChatMode(client: LlmClient, config: ReturnType<typeof getAgentConfig>): Promise<void> {
  const turns: ChatTurn[] = [];
  const rl = createInterface({ input, output });

  console.log("\n💬 Zace chat mode");
  console.log("Commands: /status, /reset, /exit\n");

  try {
    while (true) {
      const rawInput = await rl.question("you> ");
      const message = rawInput.trim();

      if (message.length === 0) {
        continue;
      }

      if (message === "/exit") {
        console.log("\nEnding chat session.\n");
        break;
      }

      if (message === "/reset") {
        turns.length = 0;
        console.log("\nSession context cleared.\n");
        continue;
      }

      if (message === "/status") {
        printChatStatus(turns);
        continue;
      }

      const task = buildChatTask(turns, message);
      console.log(`\n🔨 Zace: ${message}\n`);

      const result = await runAgentLoop(client, config, task);

      console.log(`\n${result.success ? "✅" : "❌"} ${result.message}\n`);
      console.log(`Steps executed: ${result.context.steps.length}`);
      console.log(`Final state: ${result.finalState}\n`);

      turns.push({
        assistant: result.message,
        finalState: result.finalState,
        steps: result.context.steps.length,
        user: message,
      });
    }
  } finally {
    rl.close();
  }
}

export function runCli(): void {
  const program = new Command();

  program.name("zace").description("CLI coding agent").version("0.1.0");

  applyCommonOptions(program)
    .argument("<task>", "Task for the coding agent")
    .action(
      async (task: string, options: CliOptions) => {
        try {
          // Load and validate configuration
          const config = getAgentConfig();
          applyRuntimeOptions(config, options);

          // Initialize logger
          initializeLogger(config);

          // Create LLM client
          const client = new LlmClient(config);

          // Run the agent loop
          console.log(`\n🔨 Zace: ${task}\n`);
          const result = await runAgentLoop(client, config, task);

          // Output results
          console.log(`\n${result.success ? "✅" : "❌"} ${result.message}\n`);

          if (result.context.steps.length > 0) {
            console.log(`Steps executed: ${result.context.steps.length}`);
            console.log(`Final state: ${result.finalState}\n`);
          }

          process.exit(result.success ? 0 : 1);
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
      }
    );

  applyCommonOptions(
    program
      .command("chat")
      .description("Start interactive chat mode with multi-turn context")
  ).action(async (options: CliOptions) => {
    try {
      const config = getAgentConfig();
      applyRuntimeOptions(config, options);

      initializeLogger(config);

      const client = new LlmClient(config);
      await runChatMode(client, config);

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
