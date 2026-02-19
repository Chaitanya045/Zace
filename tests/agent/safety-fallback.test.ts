import { describe, expect, test } from "bun:test";

import type { LlmClient } from "../../src/llm/client";

import { assessCommandSafety } from "../../src/agent/safety";

function createStubClient(content: string): LlmClient {
  return {
    chat: async () => ({
      content,
    }),
  } as unknown as LlmClient;
}

describe("safety fallback classifier", () => {
  test("treats new-file redirect as non-destructive when safety output is malformed", async () => {
    const assessment = await assessCommandSafety(
      createStubClient("not json"),
      "cat > bst.ts <<'EOF'\nconst value = 1;\nEOF",
      {
        overwriteRedirectTargets: [
          {
            exists: "no",
            rawPath: "bst.ts",
            resolvedPath: "/repo/bst.ts",
          },
        ],
        workingDirectory: "/repo",
      }
    );

    expect(assessment.isDestructive).toBe(false);
  });

  test("treats redirect over existing file as destructive when safety output is malformed", async () => {
    const assessment = await assessCommandSafety(
      createStubClient("{bad json"),
      "cat > bst.ts <<'EOF'\nconst value = 1;\nEOF",
      {
        overwriteRedirectTargets: [
          {
            exists: "yes",
            rawPath: "bst.ts",
            resolvedPath: "/repo/bst.ts",
          },
        ],
        workingDirectory: "/repo",
      }
    );

    expect(assessment.isDestructive).toBe(true);
    expect(assessment.reason).toContain("overwrites existing file");
  });

  test("treats explicit delete commands as destructive when safety output is malformed", async () => {
    const assessment = await assessCommandSafety(
      createStubClient("not-json"),
      "rm -rf ./dist",
      {
        overwriteRedirectTargets: [],
        workingDirectory: "/repo",
      }
    );

    expect(assessment.isDestructive).toBe(true);
  });

  test("still honors valid safety classifier JSON output", async () => {
    const assessment = await assessCommandSafety(
      createStubClient('{"isDestructive":true,"reason":"model classified as destructive"}'),
      "cat > bst.ts <<'EOF'\nconst value = 1;\nEOF",
      {
        overwriteRedirectTargets: [
          {
            exists: "no",
            rawPath: "bst.ts",
            resolvedPath: "/repo/bst.ts",
          },
        ],
        workingDirectory: "/repo",
      }
    );

    expect(assessment.isDestructive).toBe(true);
    expect(assessment.reason).toBe("model classified as destructive");
  });
});
