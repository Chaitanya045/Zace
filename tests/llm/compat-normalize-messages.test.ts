import { describe, expect, test } from "bun:test";

import { normalizeMessagesForTransport } from "../../src/llm/compat";

describe("llm compat message normalization", () => {
  test("coerces planner tool-role messages to assistant digests", () => {
    const result = normalizeMessagesForTransport({
      callKind: "planner",
      messages: [
        {
          content: "You are planner",
          role: "system",
        },
        {
          content: "Tool execute_command output: ok",
          role: "tool",
        },
      ],
      normalizeToolRole: true,
    });

    expect(result.changed).toBe(true);
    expect(result.reasons).toContain("tool_role_coercion");
    expect(result.messages[1]?.role).toBe("assistant");
    expect(result.messages[1]?.content).toContain("Tool memory digest:");
  });

  test("keeps tool role when normalization is disabled", () => {
    const result = normalizeMessagesForTransport({
      callKind: "planner",
      messages: [
        {
          content: "raw tool output",
          role: "tool",
        },
      ],
      normalizeToolRole: false,
    });

    expect(result.changed).toBe(false);
    expect(result.reasons).toContain("tool_role_disabled");
    expect(result.messages[0]?.role).toBe("tool");
  });
});
