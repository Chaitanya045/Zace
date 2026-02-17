import { Box, useApp, useInput } from "ink";

import type { LlmClient } from "../llm/client";
import type { AgentConfig } from "../types/config";

import { Composer } from "./components/composer";
import { Header } from "./components/header";
import { Timeline } from "./components/timeline";
import { useChatController } from "./hooks/use-chat-controller";
import { Separator } from "./theme/primitives";

type ChatAppProps = {
  client: LlmClient;
  config: AgentConfig;
  sessionFilePath: string;
  sessionId: string;
};

function isPrintableInput(input: string, key: { ctrl: boolean; meta: boolean }): boolean {
  if (!input) {
    return false;
  }

  if (key.ctrl || key.meta) {
    return false;
  }

  const code = input.charCodeAt(0);
  return code >= 32 && code !== 127;
}

export function ChatApp(props: ChatAppProps) {
  const { exit } = useApp();
  const controller = useChatController({
    client: props.client,
    config: props.config,
    onExit: () => {
      exit();
    },
    sessionFilePath: props.sessionFilePath,
    sessionId: props.sessionId,
  });

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "c") {
      exit();
      return;
    }

    if (key.return) {
      void controller.submitComposer();
      return;
    }

    if (key.backspace || key.delete) {
      controller.backspaceComposer();
      return;
    }

    if (isPrintableInput(input, { ctrl: key.ctrl, meta: key.meta })) {
      controller.appendComposerChar(input);
    }
  });

  return (
    <Box flexDirection="column">
      <Header
        hasPendingApproval={controller.state.hasPendingApproval}
        isBusy={controller.state.isBusy}
        runState={controller.state.runState}
        sessionFilePath={controller.state.sessionFilePath}
        sessionId={controller.state.sessionId}
        stepLabel={controller.state.stepLabel}
        turnCount={controller.state.turnCount}
      />
      <Separator />
      <Timeline entries={controller.state.timeline} />
      <Separator />
      <Composer
        isBusy={controller.state.isBusy}
        value={controller.state.composerValue}
      />
    </Box>
  );
}
