import type { SessionStoreWrite } from "../session/store";

import { newMessageId, newPartId } from "../session/ids";

type StreamPhase = "executing" | "planning";
type StreamCallKind = "executor" | "planner";

export type LlmStreamEvent =
  | {
      type: "llm_stream_delta";
      callKind: StreamCallKind;
      delta: string;
      messageId?: string;
      partId?: string;
      phase: StreamPhase;
      runId: string;
      step: number;
      toolName?: string;
    }
  | {
      type: "llm_stream_finished";
      callKind: StreamCallKind;
      messageId?: string;
      partId?: string;
      phase: StreamPhase;
      runId: string;
      step: number;
      toolName?: string;
    }
  | {
      type: "llm_stream_started";
      callKind: StreamCallKind;
      messageId?: string;
      partId?: string;
      phase: StreamPhase;
      runId: string;
      step: number;
      toolName?: string;
    }
  ;

export type CreateLlmStreamCallbacksInput = {
  callKind: StreamCallKind;
  emit?: (event: LlmStreamEvent) => void;
  onStreamEnd?: () => void;
  onStreamStart?: () => void;
  onStreamToken?: (token: string) => void;
  phase: StreamPhase;
  runId: string;
  sessionStore?: SessionStoreWrite;
  step: number;
  toolName?: string;
};

const DEFAULT_PERSIST_MIN_CHARS = 400;
const DEFAULT_PERSIST_MIN_MS = 250;

export function createLlmStreamCallbacks(input: CreateLlmStreamCallbacksInput): {
  onStreamEnd: () => void;
  onStreamStart: () => void;
  onStreamToken: (token: string) => void;
} {
  let messageId: string | undefined;
  let partId: string | undefined;
  let started = false;

  let accumulatedText = "";
  let lastPersistedLength = 0;
  let lastPersistedAt = 0;

  const maybePersist = async (force: boolean): Promise<void> => {
    if (!input.sessionStore || !messageId || !partId) {
      return;
    }
    const now = Date.now();
    const lengthDelta = accumulatedText.length - lastPersistedLength;
    const msDelta = now - lastPersistedAt;
    if (!force && lengthDelta < DEFAULT_PERSIST_MIN_CHARS && msDelta < DEFAULT_PERSIST_MIN_MS) {
      return;
    }

    lastPersistedLength = accumulatedText.length;
    lastPersistedAt = now;
    try {
      await input.sessionStore.appendPartDelta({
        delta: {
          text: accumulatedText,
        },
        messageId,
        partId,
      });
    } catch {
      // Best-effort persistence.
    }
  };

  return {
    onStreamEnd: () => {
      void (async () => {
        if (started) {
          await maybePersist(true);
        }
        input.emit?.({
          callKind: input.callKind,
          messageId,
          partId,
          phase: input.phase,
          runId: input.runId,
          step: input.step,
          toolName: input.toolName,
          type: "llm_stream_finished",
        });
      })();
      input.onStreamEnd?.();
    },
    onStreamStart: () => {
      input.onStreamStart?.();
      started = true;

      if (input.sessionStore) {
        const sessionStore = input.sessionStore;
        messageId = newMessageId();
        partId = newPartId();
        void (async () => {
          try {
            await sessionStore.appendMessage({
              createdAt: new Date().toISOString(),
              id: messageId,
              parts: [
                {
                  id: partId,
                  kind: "text",
                  metadata: {
                    callKind: input.callKind,
                    phase: input.phase,
                    runId: input.runId,
                    step: input.step,
                    ...(input.toolName ? { toolName: input.toolName } : {}),
                  },
                  text: "",
                },
              ],
              role: "assistant",
            });
          } catch {
            // Best-effort persistence.
          }
        })();
      }

      input.emit?.({
        callKind: input.callKind,
        messageId,
        partId,
        phase: input.phase,
        runId: input.runId,
        step: input.step,
        toolName: input.toolName,
        type: "llm_stream_started",
      });
    },
    onStreamToken: (token) => {
      input.onStreamToken?.(token);
      accumulatedText += token;
      input.emit?.({
        callKind: input.callKind,
        delta: token,
        messageId,
        partId,
        phase: input.phase,
        runId: input.runId,
        step: input.step,
        toolName: input.toolName,
        type: "llm_stream_delta",
      });
      void maybePersist(false);
    },
  };
}
