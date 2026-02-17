import { render } from "ink";
import { createElement } from "react";

import type { LlmClient } from "../llm/client";
import type { AgentConfig } from "../types/config";

import { getSessionFilePath } from "../tools/session";
import { ChatApp } from "./app";

type RunChatUiInput = {
  client: LlmClient;
  config: AgentConfig;
  sessionId: string;
};

export function isInteractiveTerminal(): boolean {
  const term = process.env.TERM?.toLowerCase();
  if (term === "dumb") {
    return false;
  }

  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export async function runChatUi(input: RunChatUiInput): Promise<void> {
  const sessionFilePath = getSessionFilePath(input.sessionId);
  const instance = render(
    createElement(ChatApp, {
      client: input.client,
      config: input.config,
      sessionFilePath,
      sessionId: input.sessionId,
    })
  );
  await instance.waitUntilExit();
}
