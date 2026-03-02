import type { LlmMessage } from "../llm/types";
import type { MessagePartV2, MessageV2 } from "./message-v2";

function stringifyPart(part: MessagePartV2): string {
  switch (part.kind) {
    case "reasoning":
      return part.text;
    case "text":
      return part.text;
    case "tool_call":
      return `[tool_call name=${part.name} id=${part.toolCallId}]`;
    case "tool_result":
      return [
        `[tool_result name=${part.name} id=${part.toolCallId} success=${String(part.success)}]`,
        part.output,
      ].join("\n");
    case "step_start":
      return `[step_start step=${String(part.step)} id=${part.stepId}]`;
    case "step_finish":
      return `[step_finish step=${String(part.step)} id=${part.stepId} status=${part.status}]`;
    case "patch":
      return `[patch files=${part.files.join(",")}]`;
  }
}

export function toLlmMessages(messages: MessageV2[]): LlmMessage[] {
  return messages.map((message) => ({
    content: message.parts.map((part) => stringifyPart(part)).join("\n"),
    role: message.role,
  }));
}
