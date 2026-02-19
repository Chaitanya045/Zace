import type { AgentObserver } from "../../observer";
import type { RunEventPhase } from "./types";

import { appendSessionRunEvent } from "../../../tools/session";
import { logError } from "../../../utils/logger";

export async function appendRunEvent(input: {
  event: string;
  observer?: AgentObserver;
  payload?: Record<string, unknown>;
  phase: RunEventPhase;
  runId: string;
  sessionId?: string;
  step: number;
}): Promise<void> {
  input.observer?.onRunEvent?.({
    event: input.event,
    phase: input.phase,
    step: input.step,
  });

  if (!input.sessionId) {
    return;
  }

  try {
    await appendSessionRunEvent(input.sessionId, {
      event: input.event,
      payload: input.payload,
      phase: input.phase,
      runId: input.runId,
      step: input.step,
    });
  } catch (error) {
    logError("Failed to append run event", error);
  }
}
