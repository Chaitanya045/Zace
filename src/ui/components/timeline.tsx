import { Box, Text } from "ink";

import type { TimelineEntry, TimelineEntryTone } from "../types";

import { Badge, MutedText, Panel } from "../theme/primitives";
import { colorTokens } from "../theme/tokens";

type TimelineProps = {
  entries: TimelineEntry[];
};

const MAX_RENDERED_ENTRIES = 80;

function toneToColor(tone: TimelineEntryTone) {
  switch (tone) {
    case "accent":
      return colorTokens.accent;
    case "danger":
      return colorTokens.danger;
    case "muted":
      return colorTokens.muted;
    case "success":
      return colorTokens.success;
    default:
      return colorTokens.foreground;
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${hour}:${minute}:${second}`;
}

function renderBody(entry: TimelineEntry): string {
  const normalized = entry.body.trim();
  if (!normalized) {
    return entry.streaming ? "..." : "(empty)";
  }

  const truncated = normalized.length > 1_200
    ? `${normalized.slice(0, 1_200)}\n...[truncated]`
    : normalized;
  return truncated;
}

export function Timeline(props: TimelineProps) {
  const entries = props.entries.slice(-MAX_RENDERED_ENTRIES);

  return (
    <Panel flexGrow={1} title="Timeline">
      {entries.length === 0 ? (
        <MutedText>No messages yet. Start by typing below.</MutedText>
      ) : (
        entries.map((entry) => (
          <Box flexDirection="column" key={entry.id} marginBottom={1}>
            <Box flexDirection="row" marginBottom={0}>
              <Box marginRight={1}>
                <Badge label={entry.kind} tone={entry.tone} />
              </Box>
              <MutedText>{formatTime(entry.timestamp)}</MutedText>
              {entry.streaming ? (
                <Box marginLeft={1}>
                  <Text color={colorTokens.accent}>● streaming</Text>
                </Box>
              ) : null}
            </Box>
            {entry.title ? <Text color={colorTokens.muted}>{entry.title}</Text> : null}
            <Text color={toneToColor(entry.tone)}>{renderBody(entry)}</Text>
          </Box>
        ))
      )}
    </Panel>
  );
}
