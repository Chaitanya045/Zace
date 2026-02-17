import { describe, expect, test } from "bun:test";

import type { AgentToolCallEvent, AgentToolResultEvent } from "../../src/agent/observer";

import { buildToolCallTimelineEntry, buildToolResultTimelineEntry } from "../../src/ui/event-model";

describe("ui event model", () => {
  test("maps tool call event to timeline draft", () => {
    const event: AgentToolCallEvent = {
      arguments: {
        command: "echo hi",
        timeout: 30_000,
      },
      attempt: 2,
      name: "execute_command",
      step: 3,
    };

    const draft = buildToolCallTimelineEntry(event);
    expect(draft.kind).toBe("tool");
    expect(draft.title).toBe("Tool call");
    expect(draft.tone).toBe("accent");
    expect(draft.body).toContain("Step 3 attempt 2");
    expect(draft.body).toContain("Tool: execute_command");
    expect(draft.body).toContain("\"command\": \"echo hi\"");
  });

  test("maps tool result event to timeline draft", () => {
    const event: AgentToolResultEvent = {
      attempt: 1,
      error: "Exit code 1",
      name: "execute_command",
      output: "lint failed",
      step: 4,
      success: false,
    };

    const draft = buildToolResultTimelineEntry(event);
    expect(draft.kind).toBe("tool");
    expect(draft.title).toBe("Tool result");
    expect(draft.tone).toBe("danger");
    expect(draft.body).toContain("Step 4 attempt 1");
    expect(draft.body).toContain("Result: failure");
    expect(draft.body).toContain("Error: Exit code 1");
    expect(draft.body).toContain("lint failed");
  });
});
