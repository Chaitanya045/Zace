import { describe, expect, test } from "bun:test";

import { buildToolMemoryDigest } from "../../src/agent/loop";

describe("planner context hygiene", () => {
  test("tool memory digest excludes oversized stdout/stderr payloads", () => {
    const largeStdout = "A".repeat(5000);
    const largeStderr = "B".repeat(5000);
    const digest = buildToolMemoryDigest({
      attempt: 1,
      toolName: "execute_command",
      toolResult: {
        output: [
          `[stdout]\n${largeStdout}`,
          `[stderr]\n${largeStderr}`,
          "[execution]\nshell: sh\ncwd: /tmp\nexit_code: 0",
          "[artifacts]\nstdout: /tmp/stdout.log\nstderr: /tmp/stderr.log\ncombined: /tmp/all.log",
        ].join("\n\n"),
        success: true,
      },
    });

    expect(digest).toContain("[execution]");
    expect(digest).toContain("[artifacts]");
    expect(digest.includes("A".repeat(256))).toBe(false);
    expect(digest.includes("B".repeat(256))).toBe(false);
  });
});
