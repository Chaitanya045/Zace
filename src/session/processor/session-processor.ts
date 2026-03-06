import type { AgentObserver } from "../../agent/observer";
import type { AgentProcessorEvent } from "../../agent/stream-events";
import type { LlmClient } from "../../llm/client";
import type { AgentConfig } from "../../types/config";
import type { AbortSignalLike, ToolExecutionContext, ToolResult } from "../../types/tool";

import { runAgentLoop, type AgentResult } from "../../agent/loop";
import { appendSessionEntries } from "../../tools/session";

export type SessionProcessorTurnInput = {
  abortSignal?: AbortSignalLike;
  approvedCommandSignaturesOnce?: string[];
  approvedPermissionsOnce?: Array<{ pattern: string; permission: string }>;
  client: LlmClient;
  config: AgentConfig;
  executeToolCall?: (
    toolCall: {
      arguments: Record<string, unknown>;
      name: string;
    },
    context?: ToolExecutionContext
  ) => Promise<ToolResult>;
  observer?: AgentObserver;
  onProcessorEvent?: (event: AgentProcessorEvent) => void;
  sessionId: string;
  task: string;
  userMessage: string;
};

export type SessionProcessorTurnResult = {
  endedAt: Date;
  result: AgentResult;
  startedAt: Date;
};

export const SessionProcessor = {
  async runTurn(input: SessionProcessorTurnInput): Promise<SessionProcessorTurnResult> {
    const startedAt = new Date();
    const result = await runAgentLoop(input.client, input.config, input.task, {
      abortSignal: input.abortSignal,
      approvedCommandSignaturesOnce: input.approvedCommandSignaturesOnce,
      approvedPermissionsOnce: input.approvedPermissionsOnce,
      deferLongTermMemoryPersistence: true,
      executeToolCall: input.executeToolCall,
      observer: input.observer,
      onProcessorEvent: input.onProcessorEvent,
      sessionId: input.sessionId,
    });
    const endedAt = new Date();

    const endedAtIso = endedAt.toISOString();
    const startedAtIso = startedAt.toISOString();
    const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
    const summary = result.message;

    await appendSessionEntries(input.sessionId, [
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
        sessionId: input.sessionId,
        startedAt: startedAtIso,
        steps: result.context.steps.length,
        success: result.success,
        summary,
        task: input.task,
        type: "run",
        userMessage: input.userMessage,
      },
    ]);

    return {
      endedAt,
      result,
      startedAt,
    };
  },
};
