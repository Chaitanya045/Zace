import { describe, expect, test } from "bun:test";

import { PLANNER_RESPONSE_JSON_SCHEMA } from "../../src/agent/planner-schema";
import { parsePlannerJsonOnly } from "../../src/agent/planner/parser";

function expectStrictPlannerRejects(payload: unknown): void {
  const parsed = parsePlannerJsonOnly(JSON.stringify(payload));
  expect(parsed.success).toBe(false);
}

describe("planner tool-call schema consistency", () => {
  test("rejects invalid per-tool payloads in strict parser", () => {
    expectStrictPlannerRejects({
      action: "continue",
      reasoning: "Run shell command",
      toolCall: {
        arguments: {},
        name: "execute_command",
      },
    });

    expectStrictPlannerRejects({
      action: "continue",
      reasoning: "Search session",
      toolCall: {
        arguments: {
          query: "foo",
        },
        name: "search_session_messages",
      },
    });

    expectStrictPlannerRejects({
      action: "continue",
      reasoning: "Write session note",
      toolCall: {
        arguments: {
          sessionId: "chat-1",
        },
        name: "write_session_message",
      },
    });
  });

  test("transport schema encodes tool-aware required arguments", () => {
    const properties = (PLANNER_RESPONSE_JSON_SCHEMA as {
      properties?: Record<string, unknown>;
    }).properties;
    const toolCallSchema = properties?.toolCall as { oneOf?: Array<Record<string, unknown>> };
    const variants = toolCallSchema?.oneOf ?? [];

    expect(variants.length).toBe(3);

    const variantByName = new Map<string, Record<string, unknown>>();
    for (const variant of variants) {
      const variantProperties = (variant.properties ?? {}) as Record<string, unknown>;
      const nameProperty = variantProperties.name as { const?: string };
      if (typeof nameProperty?.const === "string") {
        variantByName.set(nameProperty.const, variant);
      }
    }

    const executeVariant = variantByName.get("execute_command");
    const executeArguments = (executeVariant?.properties as Record<string, unknown>)?.arguments as {
      required?: string[];
    };
    expect(executeArguments.required).toContain("command");

    const searchVariant = variantByName.get("search_session_messages");
    const searchArguments = (searchVariant?.properties as Record<string, unknown>)?.arguments as {
      required?: string[];
    };
    expect(searchArguments.required).toContain("sessionId");

    const writeVariant = variantByName.get("write_session_message");
    const writeArguments = (writeVariant?.properties as Record<string, unknown>)?.arguments as {
      required?: string[];
    };
    expect(writeArguments.required).toContain("sessionId");
    expect(writeArguments.required).toContain("content");
  });
});
