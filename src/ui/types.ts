export type TimelineEntryKind = "assistant" | "error" | "status" | "system" | "tool" | "user";

export type TimelineEntryTone = "accent" | "danger" | "default" | "muted" | "success";

export interface TimelineEntry {
  body: string;
  id: string;
  kind: TimelineEntryKind;
  streaming?: boolean;
  timestamp: number;
  title?: string;
  tone: TimelineEntryTone;
}

export interface ChatUiState {
  composerValue: string;
  hasPendingApproval: boolean;
  isBusy: boolean;
  pendingFollowUpQuestion?: string;
  runState: string;
  sessionFilePath: string;
  sessionId: string;
  stepLabel?: string;
  timeline: TimelineEntry[];
  turnCount: number;
}

export type ChatUiAction =
  | { type: "append_composer_char"; value: string }
  | { type: "append_entry"; entry: TimelineEntry }
  | { type: "append_to_entry"; chunk: string; id: string }
  | { type: "clear_timeline" }
  | { type: "pop_composer_char" }
  | { type: "set_busy"; value: boolean }
  | { type: "set_composer"; value: string }
  | { type: "set_entry_streaming"; id: string; value: boolean }
  | { type: "set_pending_approval"; value: boolean }
  | { type: "set_pending_follow_up"; value?: string }
  | { type: "set_run_state"; value: string }
  | { type: "set_step_label"; value?: string }
  | { type: "set_turn_count"; value: number };

export interface ChatUiController {
  appendComposerChar: (value: string) => void;
  backspaceComposer: () => void;
  requestInterrupt: () => "already_requested" | "not_running" | "requested";
  state: ChatUiState;
  submitComposer: () => Promise<void>;
}

export const MAX_TIMELINE_ENTRIES = 240;
