import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { AgentObserver } from "../agent/observer";
import type { LlmClient } from "../llm/client";
import type { AgentConfig } from "../types/config";

import { runAgentLoop } from "../agent/loop";
import {
  buildChatTaskWithFollowUp,
  loadSessionState,
  persistSessionTurn,
  type ChatTurn,
} from "../cli/chat-session";
import { getSessionFilePath } from "../tools/session";

function createPlainStreamObserver(config: AgentConfig): AgentObserver | undefined {
  if (!config.stream) {
    return undefined;
  }

  return {
    onExecutorStreamEnd: () => {
      process.stdout.write("\n");
    },
    onExecutorStreamStart: (event) => {
      process.stdout.write(`\n\n[LLM:executor:${event.toolName}]\n`);
    },
    onExecutorStreamToken: (event) => {
      process.stdout.write(event.token);
    },
    onPlannerStreamEnd: () => {
      process.stdout.write("\n");
    },
    onPlannerStreamStart: () => {
      process.stdout.write("\n\n[LLM:planner]\n");
    },
    onPlannerStreamToken: (token) => {
      process.stdout.write(token);
    },
  };
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

export async function runPlainChatMode(
  client: LlmClient,
  config: AgentConfig,
  sessionId: string
): Promise<void> {
  const turns: ChatTurn[] = [];
  let pendingFollowUpQuestion: string | undefined;
  const rl = createInterface({ input, output });
  const streamObserver = createPlainStreamObserver(config);

  const sessionState = await loadSessionState(sessionId);
  turns.push(...sessionState.turns);
  pendingFollowUpQuestion = sessionState.pendingFollowUpQuestion;

  console.log("\n💬 Zace chat mode (plain fallback)");
  console.log("Commands: /status, /reset, /exit\n");
  console.log(`Session: ${sessionId} (${getSessionFilePath(sessionId)})`);
  console.log(`Loaded turns: ${turns.length}\n`);
  if (pendingFollowUpQuestion) {
    console.log(`Pending follow-up question: ${pendingFollowUpQuestion}\n`);
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
        console.log("\nSession context cleared in memory (session file unchanged).\n");
        continue;
      }

      if (message === "/status") {
        printChatStatus(turns);
        continue;
      }

      const task = buildChatTaskWithFollowUp(turns, message, pendingFollowUpQuestion);
      console.log(`\n🔨 Zace: ${message}\n`);

      const startedAt = new Date();
      const result = await runAgentLoop(client, config, task, {
        observer: streamObserver,
        sessionId,
      });
      const endedAt = new Date();

      console.log(`\n${getResultIcon(result.success, result.finalState)} ${result.message}\n`);
      console.log(`Steps executed: ${result.context.steps.length}`);
      console.log(`Final state: ${result.finalState}\n`);

      await persistSessionTurn(sessionId, message, task, result, startedAt, endedAt);

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
