import { describe, expect, test } from "bun:test";

import { parseEnvironment } from "../../src/config/env";

function createBaseEnvironment(): Record<string, string | undefined> {
  return {
    AGENT_COMMAND_ARTIFACTS_DIR: ".zace/runtime/artifacts",
    AGENT_TOOL_OUTPUT_LIMIT_CHARS: "8000",
    LLM_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "test-model",
  };
}

describe("env boolean parsing", () => {
  test("parses explicit false values correctly", () => {
    const parsed = parseEnvironment({
      ...createBaseEnvironment(),
      AGENT_COMPLETION_REQUIRE_LSP: "false",
      AGENT_LSP_ENABLED: "off",
      AGENT_STREAM: "0",
      AGENT_VERBOSE: "",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.AGENT_COMPLETION_REQUIRE_LSP).toBe(false);
    expect(parsed.data.AGENT_LSP_ENABLED).toBe(false);
    expect(parsed.data.AGENT_STREAM).toBe(false);
    expect(parsed.data.AGENT_VERBOSE).toBe(false);
  });

  test("parses explicit true values correctly", () => {
    const parsed = parseEnvironment({
      ...createBaseEnvironment(),
      AGENT_COMPLETION_REQUIRE_LSP: "yes",
      AGENT_LSP_ENABLED: "on",
      AGENT_STREAM: "1",
      AGENT_VERBOSE: "true",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.AGENT_COMPLETION_REQUIRE_LSP).toBe(true);
    expect(parsed.data.AGENT_LSP_ENABLED).toBe(true);
    expect(parsed.data.AGENT_STREAM).toBe(true);
    expect(parsed.data.AGENT_VERBOSE).toBe(true);
  });

  test("rejects invalid boolean strings", () => {
    const parsed = parseEnvironment({
      ...createBaseEnvironment(),
      AGENT_COMPLETION_REQUIRE_LSP: "not-a-boolean",
    });

    expect(parsed.success).toBe(false);
  });
});
