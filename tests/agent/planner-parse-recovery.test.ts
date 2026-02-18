import { describe, expect, test } from "bun:test";

import type { LlmClient } from "../../src/llm/client";
import type { AgentContext } from "../../src/types/agent";

import { plan } from "../../src/agent/planner";

function createContext(): AgentContext {
  return {
    currentStep: 0,
    fileSummaries: new Map(),
    maxSteps: 4,
    scriptCatalog: new Map(),
    steps: [],
    task: "Create a file with BST implementation.",
  };
}

describe("planner parse recovery", () => {
  test("recovers from invalid planner output using JSON repair", async () => {
    let chatCalls = 0;
    const llmClient = {
      chat: async () => {
        chatCalls += 1;
        if (chatCalls === 1) {
          return {
            content: "Planning: I will inspect files next.\n<tool_call>",
          };
        }

        return {
          content: JSON.stringify({
            action: "continue",
            reasoning: "Inspect repository structure first.",
            toolCall: {
              arguments: {
                command: "ls -la",
              },
              name: "execute_command",
            },
          }),
        };
      },
    } as unknown as LlmClient;

    const result = await plan(llmClient, createContext(), {
      getMessages: () => [],
    });

    expect(result.action).toBe("continue");
    expect(result.parseMode).toBe("repair_json");
    expect(result.parseAttempts).toBe(2);
    expect(result.rawInvalidCount).toBe(1);
  });

  test("returns blocked when parser exhausts retries", async () => {
    let chatCalls = 0;
    const llmClient = {
      chat: async () => {
        chatCalls += 1;
        return {
          content: "This is not valid planner JSON output.",
        };
      },
    } as unknown as LlmClient;

    const result = await plan(
      llmClient,
      createContext(),
      {
        getMessages: () => [],
      },
      {
        plannerParseMaxRepairs: 1,
        plannerParseRetryOnFailure: false,
      }
    );

    expect(result.action).toBe("blocked");
    expect(result.parseMode).toBe("failed");
    expect(result.parseAttempts).toBe(2);
    expect(result.rawInvalidCount).toBe(2);
    expect(result.reasoning).toContain("Planner output parsing failed");
    expect(chatCalls).toBe(2);
  });
});
