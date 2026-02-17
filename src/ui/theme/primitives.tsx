import type { PropsWithChildren } from "react";

import { Box, Text } from "ink";

import { colorTokens } from "./tokens";

type BadgeProps = {
  label: string;
  tone?: "accent" | "danger" | "default" | "muted" | "success";
};

type PanelProps = PropsWithChildren<{
  flexGrow?: number;
  title?: string;
}>;

type StatusLineProps = {
  segments: Array<{
    tone?: "accent" | "danger" | "default" | "muted" | "success";
    value: string;
  }>;
};

function toneToColor(tone: BadgeProps["tone"]) {
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

export function Badge(props: BadgeProps) {
  return <Text color={toneToColor(props.tone)}>[{props.label}]</Text>;
}

export function MutedText(props: PropsWithChildren) {
  return <Text color={colorTokens.muted}>{props.children}</Text>;
}

export function Panel(props: PanelProps) {
  return (
    <Box
      borderColor={colorTokens.border}
      borderStyle="round"
      flexDirection="column"
      flexGrow={props.flexGrow}
      paddingX={1}
      paddingY={0}
    >
      {props.title ? (
        <Box marginBottom={0}>
          <MutedText>{props.title}</MutedText>
        </Box>
      ) : null}
      {props.children}
    </Box>
  );
}

export function Separator() {
  const width = Math.max(10, (process.stdout.columns ?? 80) - 2);
  return <Text color={colorTokens.border}>{"─".repeat(width)}</Text>;
}

export function StatusLine(props: StatusLineProps) {
  return (
    <Box flexDirection="row">
      {props.segments.map((segment, index) => (
        <Box key={`${segment.value}-${String(index)}`} marginRight={1}>
          <Badge label={segment.value} tone={segment.tone} />
        </Box>
      ))}
    </Box>
  );
}
