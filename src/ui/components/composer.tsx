import { Box, Text } from "ink";

import { MutedText, Panel, StatusLine } from "../theme/primitives";
import { colorTokens } from "../theme/tokens";

type ComposerProps = {
  isBusy: boolean;
  value: string;
};

export function Composer(props: ComposerProps) {
const hintText = props.isBusy
    ? "Agent is running. You can keep typing, but submit waits for current run to finish."
    : "Enter send | /status | /reset | /exit | Ctrl+C";

  return (
    <Panel title="Composer">
      <Box flexDirection="row">
        <Text color={colorTokens.accent}>{">"}</Text>
        <Box marginLeft={1}>
          <Text color={colorTokens.foreground}>{props.value || " "}</Text>
        </Box>
      </Box>
      <MutedText>{hintText}</MutedText>
      <StatusLine
        segments={[
          { tone: props.isBusy ? "accent" : "muted", value: props.isBusy ? "busy" : "ready" },
          { tone: "muted", value: "buffer:33ms" },
        ]}
      />
    </Panel>
  );
}
