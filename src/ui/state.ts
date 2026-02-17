import type { ChatUiAction, ChatUiState } from "./types";

import { MAX_TIMELINE_ENTRIES } from "./types";

export function createInitialChatUiState(input: {
  sessionFilePath: string;
  sessionId: string;
}): ChatUiState {
  return {
    composerValue: "",
    hasPendingApproval: false,
    isBusy: false,
    runState: "idle",
    sessionFilePath: input.sessionFilePath,
    sessionId: input.sessionId,
    timeline: [],
    turnCount: 0,
  };
}

function withCappedTimeline(state: ChatUiState): ChatUiState {
  if (state.timeline.length <= MAX_TIMELINE_ENTRIES) {
    return state;
  }

  return {
    ...state,
    timeline: state.timeline.slice(-MAX_TIMELINE_ENTRIES),
  };
}

export function chatUiReducer(state: ChatUiState, action: ChatUiAction): ChatUiState {
  switch (action.type) {
    case "append_composer_char":
      return {
        ...state,
        composerValue: `${state.composerValue}${action.value}`,
      };
    case "append_entry":
      return withCappedTimeline({
        ...state,
        timeline: [...state.timeline, action.entry],
      });
    case "append_to_entry":
      return {
        ...state,
        timeline: state.timeline.map((entry) =>
          entry.id === action.id
            ? {
                ...entry,
                body: `${entry.body}${action.chunk}`,
              }
            : entry
        ),
      };
    case "clear_timeline":
      return {
        ...state,
        timeline: [],
      };
    case "pop_composer_char":
      return {
        ...state,
        composerValue: state.composerValue.slice(0, -1),
      };
    case "set_busy":
      return {
        ...state,
        isBusy: action.value,
      };
    case "set_composer":
      return {
        ...state,
        composerValue: action.value,
      };
    case "set_entry_streaming":
      return {
        ...state,
        timeline: state.timeline.map((entry) =>
          entry.id === action.id
            ? {
                ...entry,
                streaming: action.value,
              }
            : entry
        ),
      };
    case "set_pending_follow_up":
      return {
        ...state,
        pendingFollowUpQuestion: action.value,
      };
    case "set_pending_approval":
      return {
        ...state,
        hasPendingApproval: action.value,
      };
    case "set_run_state":
      return {
        ...state,
        runState: action.value,
      };
    case "set_step_label":
      return {
        ...state,
        stepLabel: action.value,
      };
    case "set_turn_count":
      return {
        ...state,
        turnCount: action.value,
      };
    default:
      return state;
  }
}
