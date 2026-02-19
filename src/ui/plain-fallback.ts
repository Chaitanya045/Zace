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
  resolvePendingApprovalFromUserMessage,
  type ChatTurn,
} from "../cli/chat-session";
import { getSessionFilePath } from "../tools/session";

function createPlainStreamObserver(config: AgentConfig): AgentObserver | undefined {
  if (!config.stream) {
    return undefined;
  }

  return {
    onApprovalRequested: (event) => {
      process.stdout.write(
        `\n\n[approval:requested:step:${String(event.step)}]\nReason: ${event.reason}\nCommand: ${event.command}\n`
      );
    },
    onApprovalResolved: (event) => {
      process.stdout.write(
        `\n[approval:resolved] decision=${event.decision} scope=${event.scope}\n`
      );
    },
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

function printChatStatus(
  turns: ChatTurn[],
  pendingApproval: boolean,
  pendingFollowUpQuestion?: string
): void {
  const lastTurn = turns[turns.length - 1];

  console.log("\n📌 Chat status");
  console.log(`Turns: ${turns.length}`);
  console.log(`Pending follow-up: ${pendingFollowUpQuestion ? "yes" : "no"}`);
  console.log(`Pending approval: ${pendingApproval ? "yes" : "no"}`);
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
  let pendingApproval: Awaited<ReturnType<typeof loadSessionState>>["pendingApproval"];
  let pendingFollowUpQuestion: string | undefined;
  const rl = createInterface({ input, output });
  const streamObserver = createPlainStreamObserver(config);
  let activeAbortController: globalThis.AbortController | undefined;
  let interruptRequested = false;

  const sigintHandler = (): void => {
    if (activeAbortController && !activeAbortController.signal.aborted && !interruptRequested) {
      interruptRequested = true;
      activeAbortController.abort();
      console.log("\n\nInterrupt requested. Press Ctrl+C again to force exit.\n");
      return;
    }
    process.exit(130);
  };

  process.on("SIGINT", sigintHandler);

  const sessionState = await loadSessionState(
    sessionId,
    config.pendingActionMaxAgeMs,
    config.approvalMemoryEnabled,
    config.interruptedRunRecoveryEnabled
  );
  turns.push(...sessionState.turns);
  pendingApproval = sessionState.pendingApproval;
  pendingFollowUpQuestion = sessionState.pendingFollowUpQuestion;

  console.log("\n💬 Zace chat mode (plain fallback)");
  console.log("Commands: /status, /reset, /exit\n");
  console.log(`Session: ${sessionId} (${getSessionFilePath(sessionId)})`);
  console.log(`Loaded turns: ${turns.length}\n`);
  if (pendingFollowUpQuestion) {
    console.log(`Pending follow-up question: ${pendingFollowUpQuestion}\n`);
  }
  if (pendingApproval) {
    console.log(`Pending approval command: ${pendingApproval.context.command}\n`);
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
        pendingApproval = undefined;
        pendingFollowUpQuestion = undefined;
        console.log("\nSession context cleared in memory (session file unchanged).\n");
        continue;
      }

      if (message === "/status") {
        printChatStatus(turns, Boolean(pendingApproval), pendingFollowUpQuestion);
        continue;
      }

      const followUpQuestionForTask = pendingFollowUpQuestion;
      let approvalResolutionNote: string | undefined;
      let approvedCommandSignaturesOnce: string[] | undefined;
      if (pendingApproval) {
        const approvalResolution = await resolvePendingApprovalFromUserMessage({
          client,
          config,
          pendingApproval,
          sessionId,
          userInput: message,
        });
        if (approvalResolution?.status === "unclear") {
          console.log(`\n❓ ${approvalResolution.message}\n`);
          continue;
        }

        if (approvalResolution?.status === "resolved") {
          approvalResolutionNote = approvalResolution.contextNote;
          if (approvalResolution.scope === "once" && approvalResolution.commandSignature) {
            approvedCommandSignaturesOnce = [approvalResolution.commandSignature];
          }
          pendingApproval = undefined;
          pendingFollowUpQuestion = undefined;
          console.log(`\n🧭 ${approvalResolution.message}\n`);
        }
      }

      const task = buildChatTaskWithFollowUp(
        turns,
        message,
        followUpQuestionForTask,
        approvalResolutionNote
      );
      console.log(`\n🔨 Zace: ${message}\n`);

      const startedAt = new Date();
      activeAbortController = new globalThis.AbortController();
      interruptRequested = false;
      const result = await runAgentLoop(client, config, task, {
        abortSignal: activeAbortController.signal,
        approvedCommandSignaturesOnce,
        observer: streamObserver,
        sessionId,
      });
      const endedAt = new Date();
      activeAbortController = undefined;

      console.log(`\n${getResultIcon(result.success, result.finalState)} ${result.message}\n`);
      console.log(`Steps executed: ${result.context.steps.length}`);
      console.log(`Final state: ${result.finalState}\n`);

      await persistSessionTurn(sessionId, message, task, result, startedAt, endedAt);

      if (result.finalState === "waiting_for_user") {
        const refreshedSessionState = await loadSessionState(
          sessionId,
          config.pendingActionMaxAgeMs,
          config.approvalMemoryEnabled,
          config.interruptedRunRecoveryEnabled
        );
        pendingApproval = refreshedSessionState.pendingApproval;
        pendingFollowUpQuestion = refreshedSessionState.pendingFollowUpQuestion ?? result.message;
        console.log("Agent needs clarification. Reply with your answer.\n");
      } else {
        pendingApproval = undefined;
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
    process.off("SIGINT", sigintHandler);
    rl.close();
  }
}
