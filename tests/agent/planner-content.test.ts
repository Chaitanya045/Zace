import { describe, expect, test } from "bun:test";

import { parsePlannerContent } from "../../src/agent/planner";

describe("planner response parsing", () => {
  test("parses strict JSON continue response", () => {
    const parsed = parsePlannerContent(
      JSON.stringify({
        action: "continue",
        reasoning: "Inspect repository files first",
        toolCall: {
          arguments: {
            command: "ls -la",
          },
          name: "execute_command",
        },
      })
    );

    expect(parsed.action).toBe("continue");
    if (parsed.action !== "continue") {
      throw new Error("Expected continue action");
    }
    expect(parsed.toolCall?.name).toBe("execute_command");
  });

  test("parses strict JSON complete response with gates none", () => {
    const parsed = parsePlannerContent(
      JSON.stringify({
        action: "complete",
        gates: "none",
        reasoning: "Task completed",
        userMessage: "Done. The requested change is complete.",
      })
    );

    expect(parsed.action).toBe("complete");
    if (parsed.action !== "complete") {
      throw new Error("Expected complete action");
    }
    expect(parsed.completionGatesDeclaredNone).toBe(true);
    expect(parsed.userMessage).toBe("Done. The requested change is complete.");
  });

  test("parses legacy ask_user marker from mixed content", () => {
    const parsed = parsePlannerContent(
      "CONTINUE: analyzing context\nASK_USER: What filename do you want?"
    );

    expect(parsed.action).toBe("ask_user");
    if (parsed.action !== "ask_user") {
      throw new Error("Expected ask_user action");
    }
    expect(parsed.reasoning).toContain("filename");
    expect(parsed.userMessage).toContain("filename");
  });

  test("parses strict JSON ask_user with dedicated userMessage", () => {
    const parsed = parsePlannerContent(
      JSON.stringify({
        action: "ask_user",
        reasoning: "Task is ambiguous and needs target path.",
        userMessage: "Which file path should I modify?",
      })
    );

    expect(parsed.action).toBe("ask_user");
    if (parsed.action !== "ask_user") {
      throw new Error("Expected ask_user action");
    }
    expect(parsed.userMessage).toBe("Which file path should I modify?");
  });

  test("falls back to ask_user when no valid action is provided", () => {
    const parsed = parsePlannerContent("Hello there with no structured response");
    expect(parsed.action).toBe("ask_user");
  });

  test("does not throw on malformed brace-heavy planner content", () => {
    const parsed = parsePlannerContent(
      "CONTINUE: trying command\n{ not valid json { still not valid } }\nextra text"
    );
    expect(parsed.action).toBe("ask_user");
  });
});
