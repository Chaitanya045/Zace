import { Box, Text } from "ink";

import { Panel, StatusLine } from "../theme/primitives";
import { colorTokens } from "../theme/tokens";

type HeaderProps = {
  hasPendingApproval: boolean;
  isBusy: boolean;
  runState: string;
  sessionFilePath: string;
  sessionId: string;
  stepLabel?: string;
  turnCount: number;
};

export function Header(props: HeaderProps) {
  const statusTone = props.isBusy ? "accent" : "muted";
  const pendingApprovalLabel = props.hasPendingApproval ? "approval:pending" : "approval:none";
  const pendingApprovalTone = props.hasPendingApproval ? "danger" : "muted";

  return (
    <Panel title="Session">
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={colorTokens.foreground}>ID: {props.sessionId}</Text>
        <Text color={colorTokens.muted}>Turns: {String(props.turnCount)}</Text>
      </Box>
      <Text color={colorTokens.muted}>File: {props.sessionFilePath}</Text>
      <StatusLine
        segments={[
          { tone: statusTone, value: props.isBusy ? "running" : "idle" },
          { tone: "default", value: props.runState },
          { tone: "muted", value: props.stepLabel ?? "step:n/a" },
          { tone: pendingApprovalTone, value: pendingApprovalLabel },
        ]}
      />
    </Panel>
  );
}
