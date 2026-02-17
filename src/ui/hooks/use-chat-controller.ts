import { useCallback, useEffect, useReducer, useRef } from "react";

import type { AgentObserver } from "../../agent/observer";
import type { LlmClient } from "../../llm/client";
import type { AgentConfig } from "../../types/config";
import type {
  ChatUiController,
  TimelineEntry,
  TimelineEntryKind,
  TimelineEntryTone,
} from "../types";

import { runAgentLoop } from "../../agent/loop";
import {
  buildChatTaskWithFollowUp,
  loadSessionState,
  persistSessionTurn,
  type ChatTurn,
} from "../../cli/chat-session";
import { STREAM_BUFFER_INTERVAL_MS } from "../buffer";
import { buildToolCallTimelineEntry, buildToolResultTimelineEntry } from "../event-model";
import { chatUiReducer, createInitialChatUiState } from "../state";
import { useBufferedStream } from "./use-buffered-stream";

type StreamSlot = "executor" | "planner";

type UseChatControllerInput = {
  client: LlmClient;
  config: AgentConfig;
  onExit: () => void;
  sessionFilePath: string;
  sessionId: string;
};

function defaultToneByKind(kind: TimelineEntryKind): TimelineEntryTone {
  switch (kind) {
    case "error":
      return "danger";
    case "status":
      return "muted";
    case "tool":
      return "accent";
    case "user":
      return "default";
    default:
      return "default";
  }
}

export function useChatController(input: UseChatControllerInput): ChatUiController {
  const [state, dispatch] = useReducer(
    chatUiReducer,
    createInitialChatUiState({
      sessionFilePath: input.sessionFilePath,
      sessionId: input.sessionId,
    })
  );
  const turnsRef = useRef<ChatTurn[]>([]);
  const pendingFollowUpQuestionRef = useRef<string | undefined>(undefined);
  const sequenceRef = useRef(0);
  const streamEntryRef = useRef<Partial<Record<StreamSlot, string>>>({});

  const createTimelineEntry = useCallback(
    (entry: {
      body: string;
      kind: TimelineEntryKind;
      streaming?: boolean;
      title?: string;
      tone?: TimelineEntryTone;
    }): string => {
      const id = `timeline-${String(Date.now())}-${String(sequenceRef.current++)}`;
      const timelineEntry: TimelineEntry = {
        body: entry.body,
        id,
        kind: entry.kind,
        streaming: entry.streaming ?? false,
        timestamp: Date.now(),
        title: entry.title,
        tone: entry.tone ?? defaultToneByKind(entry.kind),
      };
      dispatch({
        entry: timelineEntry,
        type: "append_entry",
      });
      return id;
    },
    []
  );

  const streamBuffer = useBufferedStream<string>({
    intervalMs: STREAM_BUFFER_INTERVAL_MS,
    onFlush: (entryId, chunk) => {
      dispatch({
        chunk,
        id: entryId,
        type: "append_to_entry",
      });
    },
  });

  useEffect(() => {
    let isMounted = true;

    const load = async (): Promise<void> => {
      try {
        const sessionState = await loadSessionState(input.sessionId);
        if (!isMounted) {
          return;
        }

        turnsRef.current = sessionState.turns;
        pendingFollowUpQuestionRef.current = sessionState.pendingFollowUpQuestion;
        dispatch({
          type: "set_pending_follow_up",
          value: sessionState.pendingFollowUpQuestion,
        });
        dispatch({
          type: "set_turn_count",
          value: sessionState.turns.length,
        });
        createTimelineEntry({
          body: `Loaded ${String(sessionState.turns.length)} previous turn(s) from session history.`,
          kind: "status",
          tone: "muted",
        });
      } catch (error) {
        if (!isMounted) {
          return;
        }

        createTimelineEntry({
          body: `Failed to load session history: ${error instanceof Error ? error.message : "Unknown error"}`,
          kind: "error",
          tone: "danger",
        });
      }
    };

    void load();

    return () => {
      isMounted = false;
    };
  }, [createTimelineEntry, input.sessionId]);

  const appendComposerChar = useCallback((value: string): void => {
    if (!value) {
      return;
    }

    dispatch({
      type: "append_composer_char",
      value,
    });
  }, []);

  const backspaceComposer = useCallback((): void => {
    dispatch({
      type: "pop_composer_char",
    });
  }, []);

  const clearStreamSlot = useCallback((slot: StreamSlot): void => {
    const entryId = streamEntryRef.current[slot];
    if (!entryId) {
      return;
    }

    streamBuffer.flushKey(entryId);
    dispatch({
      id: entryId,
      type: "set_entry_streaming",
      value: false,
    });
    delete streamEntryRef.current[slot];
  }, [streamBuffer]);

  const submitComposer = useCallback(async (): Promise<void> => {
    const message = state.composerValue.trim();
    if (!message) {
      return;
    }

    dispatch({
      type: "set_composer",
      value: "",
    });

    if (message === "/exit") {
      input.onExit();
      return;
    }

    if (message === "/reset") {
      turnsRef.current = [];
      pendingFollowUpQuestionRef.current = undefined;
      dispatch({
        type: "set_pending_follow_up",
        value: undefined,
      });
      dispatch({
        type: "set_turn_count",
        value: 0,
      });
      dispatch({
        type: "clear_timeline",
      });
      createTimelineEntry({
        body: "Conversation context was reset in memory. Session file remains unchanged.",
        kind: "status",
      });
      return;
    }

    if (message === "/status") {
      const pending = pendingFollowUpQuestionRef.current
        ? "yes"
        : "no";
      createTimelineEntry({
        body:
          `Turns: ${String(turnsRef.current.length)}\n` +
          `Busy: ${state.isBusy ? "yes" : "no"}\n` +
          `Pending follow-up: ${pending}`,
        kind: "status",
      });
      return;
    }

    if (state.isBusy) {
      createTimelineEntry({
        body: "Agent is currently running. Wait for completion before sending another message.",
        kind: "status",
      });
      return;
    }

    createTimelineEntry({
      body: message,
      kind: "user",
      tone: "default",
    });

    dispatch({
      type: "set_busy",
      value: true,
    });
    dispatch({
      type: "set_run_state",
      value: "running",
    });
    dispatch({
      type: "set_step_label",
      value: "step:n/a",
    });

    const task = buildChatTaskWithFollowUp(
      turnsRef.current,
      message,
      pendingFollowUpQuestionRef.current
    );

    const observer: AgentObserver = {
      onCompaction: (event) => {
        createTimelineEntry({
          body: `Context compacted at step ${String(event.step)} (${String(event.ratioPercent)}%).`,
          kind: "status",
          tone: "muted",
        });
      },
      onDiagnostics: (event) => {
        const filesPreview = event.files.length > 0
          ? `\nFiles: ${event.files.slice(0, 3).join(", ")}${event.files.length > 3 ? ", ..." : ""}`
          : "";
        createTimelineEntry({
          body:
            `LSP diagnostics at step ${String(event.step)}: ${String(event.errorCount)} error(s) in ${String(event.files.length)} file(s).` +
            filesPreview,
          kind: "status",
          tone: event.errorCount > 0 ? "danger" : "muted",
        });
      },
      onError: (event) => {
        createTimelineEntry({
          body: event.message,
          kind: "error",
          tone: "danger",
        });
      },
      onExecutorStreamEnd: () => {
        clearStreamSlot("executor");
      },
      onExecutorStreamStart: (event) => {
        clearStreamSlot("executor");
        const entryId = createTimelineEntry({
          body: "",
          kind: "assistant",
          streaming: true,
          title: `Executor analysis (${event.toolName})`,
          tone: "accent",
        });
        streamEntryRef.current.executor = entryId;
      },
      onExecutorStreamToken: (event) => {
        const entryId = streamEntryRef.current.executor;
        if (!entryId) {
          return;
        }

        streamBuffer.append(entryId, event.token);
      },
      onPlannerStreamEnd: () => {
        clearStreamSlot("planner");
      },
      onPlannerStreamStart: () => {
        clearStreamSlot("planner");
        const entryId = createTimelineEntry({
          body: "",
          kind: "assistant",
          streaming: true,
          title: "Planner stream",
          tone: "accent",
        });
        streamEntryRef.current.planner = entryId;
      },
      onPlannerStreamToken: (token) => {
        const entryId = streamEntryRef.current.planner;
        if (!entryId) {
          return;
        }

        streamBuffer.append(entryId, token);
      },
      onStepStart: (event) => {
        dispatch({
          type: "set_step_label",
          value: `step:${String(event.step)}/${String(event.maxSteps)}`,
        });
      },
      onToolCall: (event) => {
        createTimelineEntry(buildToolCallTimelineEntry(event));
      },
      onToolResult: (event) => {
        createTimelineEntry(buildToolResultTimelineEntry(event));
      },
    };

    const startedAt = new Date();
    try {
      const result = await runAgentLoop(input.client, input.config, task, {
        observer,
        sessionId: input.sessionId,
      });
      const endedAt = new Date();

      await persistSessionTurn(
        input.sessionId,
        message,
        task,
        result,
        startedAt,
        endedAt
      );

      createTimelineEntry({
        body: result.message,
        kind: "assistant",
        title: `Final (${result.finalState})`,
        tone: result.success ? "success" : "default",
      });

      turnsRef.current.push({
        assistant: result.message,
        finalState: result.finalState,
        steps: result.context.steps.length,
        user: message,
      });
      dispatch({
        type: "set_turn_count",
        value: turnsRef.current.length,
      });

      if (result.finalState === "waiting_for_user") {
        pendingFollowUpQuestionRef.current = result.message;
        dispatch({
          type: "set_pending_follow_up",
          value: result.message,
        });
      } else {
        pendingFollowUpQuestionRef.current = undefined;
        dispatch({
          type: "set_pending_follow_up",
          value: undefined,
        });
      }

      dispatch({
        type: "set_run_state",
        value: result.finalState,
      });
    } catch (error) {
      createTimelineEntry({
        body: error instanceof Error ? error.message : "Unknown runtime error",
        kind: "error",
        tone: "danger",
      });
      dispatch({
        type: "set_run_state",
        value: "error",
      });
    } finally {
      clearStreamSlot("planner");
      clearStreamSlot("executor");
      streamBuffer.flushAll();
      dispatch({
        type: "set_busy",
        value: false,
      });
      dispatch({
        type: "set_step_label",
        value: undefined,
      });
    }
  }, [
    clearStreamSlot,
    createTimelineEntry,
    input.client,
    input.config,
    input.onExit,
    input.sessionId,
    state.composerValue,
    state.isBusy,
    streamBuffer,
  ]);

  return {
    appendComposerChar,
    backspaceComposer,
    state,
    submitComposer,
  };
}
