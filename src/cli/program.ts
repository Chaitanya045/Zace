import { Command } from "commander";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runAgentLoop } from "../agent/loop";
import { EXECUTOR_ANALYSIS_MODES, isExecutorAnalysisMode } from "../config/env";
import { LlmClient } from "../llm/client";
import {
  appendSessionEntries,
  getSessionFilePath,
  normalizeSessionId,
  readSessionEntries,
} from "../tools/session";
import { getAgentConfig } from "../types/config";
import { initializeLogger } from "../utils/logger";

type CliOptions = {
  executorAnalysis?: string;
  session?: string;
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
    .option("--session <id>", "Persist and resume conversation from a session id")
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

function resolveSessionId(options: CliOptions): string | undefined {
  if (!options.session) {
    return undefined;
  }

  return normalizeSessionId(options.session);
}

function buildChatTaskWithFollowUp(
  turns: ChatTurn[],
  userInput: string,
  followUpQuestion?: string
): string {
  const recentTurns = turns.slice(-MAX_CHAT_CONTEXT_TURNS);
  if (recentTurns.length === 0 && !followUpQuestion) {
    return userInput;
  }

  const history = recentTurns
    .map(
      (turn, index) =>
        `Turn ${index + 1}\nUser: ${turn.user}\nAssistant: ${turn.assistant}\nState: ${turn.finalState}`
    )
    .join("\n\n");

  const followUpContext = followUpQuestion
    ? `\n\nAGENT FOLLOW-UP QUESTION:\n${followUpQuestion}\n\nUSER FOLLOW-UP ANSWER:\n${userInput}`
    : `\n\nCURRENT USER MESSAGE:\n${userInput}`;

  return `Continue this interactive conversation using the recent context.

RECENT CONVERSATION:
${history}
${followUpContext}`;
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

function getResultIcon(success: boolean, finalState: string): string {
  if (finalState === "waiting_for_user") {
    return "❓";
  }

  return success ? "✅" : "❌";
}

async function loadSessionState(
  sessionId: string
): Promise<{ pendingFollowUpQuestion?: string; turns: ChatTurn[] }> {
  const entries = await readSessionEntries(sessionId);
  const turns = entries
    .filter((entry) => entry.type === "run")
    .map((entry) => ({
      assistant: entry.assistantMessage,
      finalState: entry.finalState,
      steps: entry.steps,
      user: entry.userMessage,
    }));

  const lastTurn = turns[turns.length - 1];
  return {
    pendingFollowUpQuestion:
      lastTurn?.finalState === "waiting_for_user" ? lastTurn.assistant : undefined,
    turns,
  };
}

async function persistSessionTurn(
  sessionId: string,
  userMessage: string,
  task: string,
  result: Awaited<ReturnType<typeof runAgentLoop>>,
  startedAt: Date,
  endedAt: Date
): Promise<void> {
  const startedAtIso = startedAt.toISOString();
  const endedAtIso = endedAt.toISOString();
  const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
  const summary = result.message;

  await appendSessionEntries(sessionId, [
    {
      content: userMessage,
      role: "user",
      timestamp: startedAtIso,
      type: "message",
    },
    {
      content: result.message,
      role: "assistant",
      timestamp: endedAtIso,
      type: "message",
    },
    {
      finalState: result.finalState,
      success: result.success,
      summary,
      timestamp: endedAtIso,
      type: "summary",
    },
    {
      assistantMessage: result.message,
      durationMs,
      endedAt: endedAtIso,
      finalState: result.finalState,
      sessionId,
      startedAt: startedAtIso,
      steps: result.context.steps.length,
      success: result.success,
      summary,
      task,
      type: "run",
      userMessage,
    },
  ]);
}

async function runChatMode(
  client: LlmClient,
  config: ReturnType<typeof getAgentConfig>,
  sessionId?: string
): Promise<void> {
  const turns: ChatTurn[] = [];
  let pendingFollowUpQuestion: string | undefined;
  const rl = createInterface({ input, output });

  if (sessionId) {
    const sessionState = await loadSessionState(sessionId);
    turns.push(...sessionState.turns);
    pendingFollowUpQuestion = sessionState.pendingFollowUpQuestion;
  }

  console.log("\n💬 Zace chat mode");
  console.log("Commands: /status, /reset, /exit\n");
  if (sessionId) {
    console.log(`Session: ${sessionId} (${getSessionFilePath(sessionId)})`);
    console.log(`Loaded turns: ${turns.length}\n`);
    if (pendingFollowUpQuestion) {
      console.log(`Pending follow-up question: ${pendingFollowUpQuestion}\n`);
    }
  }

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
        pendingFollowUpQuestion = undefined;
        if (sessionId) {
          console.log("\nSession context cleared in memory (session file unchanged).\n");
        } else {
          console.log("\nSession context cleared.\n");
        }
        continue;
      }

      if (message === "/status") {
        printChatStatus(turns);
        continue;
      }

      const task = buildChatTaskWithFollowUp(turns, message, pendingFollowUpQuestion);
      console.log(`\n🔨 Zace: ${message}\n`);

      const startedAt = new Date();
      const result = await runAgentLoop(client, config, task);
      const endedAt = new Date();

      console.log(`\n${getResultIcon(result.success, result.finalState)} ${result.message}\n`);
      console.log(`Steps executed: ${result.context.steps.length}`);
      console.log(`Final state: ${result.finalState}\n`);

      if (sessionId) {
        await persistSessionTurn(sessionId, message, task, result, startedAt, endedAt);
      }

      if (result.finalState === "waiting_for_user") {
        pendingFollowUpQuestion = result.message;
        console.log("Agent needs clarification. Reply with your answer.\n");
      } else {
        pendingFollowUpQuestion = undefined;
      }

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
          const sessionId = resolveSessionId(options);
          let pendingFollowUpQuestion: string | undefined;
          let turns: ChatTurn[] = [];

          if (sessionId) {
            const sessionState = await loadSessionState(sessionId);
            turns = sessionState.turns;
            pendingFollowUpQuestion = sessionState.pendingFollowUpQuestion;
          }

          // Initialize logger
          initializeLogger(config);

          // Create LLM client
          const client = new LlmClient(config);

          // Run the agent loop
          console.log(`\n🔨 Zace: ${task}\n`);
          const taskWithContext = sessionId
            ? buildChatTaskWithFollowUp(turns, task, pendingFollowUpQuestion)
            : task;
          const startedAt = new Date();
          const result = await runAgentLoop(client, config, taskWithContext);
          const endedAt = new Date();

          if (sessionId) {
            await persistSessionTurn(sessionId, task, taskWithContext, result, startedAt, endedAt);
            console.log(`Session saved: ${sessionId} (${getSessionFilePath(sessionId)})`);
          }

          // Output results
          console.log(`\n${getResultIcon(result.success, result.finalState)} ${result.message}\n`);

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
      const sessionId = resolveSessionId(options);

      initializeLogger(config);

      const client = new LlmClient(config);
      await runChatMode(client, config, sessionId);

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
