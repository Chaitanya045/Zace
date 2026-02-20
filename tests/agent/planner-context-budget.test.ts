import { describe, expect, test } from "bun:test";

import { buildToolMemoryDigest } from "../../src/agent/loop";

describe("planner context hygiene", () => {
  test("tool memory digest keeps complete small structured stream output", () => {
    const listing = [
      "drwxr-xr-x  8 user user 4096 .",
      "drwxr-xr-x 10 user user 4096 ..",
      "-rw-r--r--  1 user user  123 a.ts",
      "-rw-r--r--  1 user user  456 b.ts",
      "-rw-r--r--  1 user user  789 c.ts",
      "-rw-r--r--  1 user user   11 d.ts",
      "-rw-r--r--  1 user user   22 e.ts",
      "-rw-r--r--  1 user user   33 f.ts",
      "-rw-r--r--  1 user user   44 g.ts",
      "-rw-r--r--  1 user user   55 h.ts",
      "-rw-r--r--  1 user user   66 i.ts",
      "-rw-r--r--  1 user user   77 j.ts",
      "-rw-r--r--  1 user user   88 k.ts",
      "-rw-r--r--  1 user user   99 z.ts",
    ].join("\n");
    const digest = buildToolMemoryDigest({
      attempt: 1,
      toolName: "execute_command",
      toolResult: {
        output: `[stdout]\n${listing}`,
        success: true,
      },
    });

    expect(digest).toContain("[stdout_preview]");
    expect(digest).toContain("a.ts");
    expect(digest).toContain("z.ts");
    expect(digest).not.toContain("...[truncated");
  });

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
    expect(digest).toContain("[stdout_preview]");
    expect(digest).toContain("[stderr_preview]");
    expect(digest).toContain("...[truncated");
    expect(digest.includes("A".repeat(256))).toBe(false);
    expect(digest.includes("B".repeat(256))).toBe(false);
  });
});
