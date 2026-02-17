import { describe, expect, test } from "bun:test";

import {
  buildDiscoverProjectDocsCommand,
  buildReadProjectDocCommand,
  extractProjectDocFromToolOutput,
  parseDiscoveredProjectDocCandidates,
  resolveProjectDocsPolicy,
  truncateProjectDocPreview,
} from "../../src/agent/docs";

describe("project docs policy", () => {
  test("skips all docs when user explicitly disables docs usage", () => {
    const policy = resolveProjectDocsPolicy("Do not use docs for this task.", [
      "AGENTS.md",
      "README.md",
    ]);
    expect(policy.skipAllDocs).toBe(true);
    expect(policy.excludedDocPaths).toEqual(["AGENTS.md", "README.md"]);
  });

  test("skips only readme when user excludes readme", () => {
    const policy = resolveProjectDocsPolicy("Ignore README.md but use everything else.", [
      "AGENTS.md",
      "README.md",
    ]);
    expect(policy.skipAllDocs).toBe(false);
    expect(policy.excludedDocPaths).toContain("README.md");
    expect(policy.excludedDocPaths).not.toContain("AGENTS.md");
  });
});

describe("project doc command helpers", () => {
  test("builds doc discovery shell command with candidate marker", () => {
    const command = buildDiscoverProjectDocsCommand({
      maxDepth: 4,
      maxFiles: 10,
      platform: "darwin",
    });

    expect(command).toContain("find . -maxdepth 4");
    expect(command).toContain("ZACE_DOC_CANDIDATE|");
  });

  test("parses and sanitizes discovered doc candidates", () => {
    const discovered = parseDiscoveredProjectDocCandidates(
      [
        "[stdout]",
        "ZACE_DOC_CANDIDATE|README.md",
        "ZACE_DOC_CANDIDATE|docs/guide.md",
        "ZACE_DOC_CANDIDATE|./docs/guide.md",
        "ZACE_DOC_CANDIDATE|../secrets.md",
        "",
        "[stderr]",
        "(empty)",
      ].join("\n")
    );

    expect(discovered).toEqual(["README.md", "docs/guide.md"]);
  });

  test("builds shell read command with markers on unix-like platforms", () => {
    const command = buildReadProjectDocCommand({
      filePath: "README.md",
      maxLines: 120,
      platform: "darwin",
    });

    expect(command).toContain("ZACE_DOC_BEGIN|README.md");
    expect(command).toContain("sed -n '1,120p'");
  });

  test("extracts doc content from tool output markers", () => {
    const extracted = extractProjectDocFromToolOutput({
      filePath: "README.md",
      toolOutput: [
        "[stdout]",
        "ZACE_DOC_BEGIN|README.md",
        "# Project",
        "Line 2",
        "ZACE_DOC_END|README.md",
        "",
        "[stderr]",
        "(empty)",
        "",
      ].join("\n"),
    });

    expect(extracted).toBe("# Project\nLine 2");
  });

  test("truncates long doc previews", () => {
    const content = "a".repeat(60);
    const preview = truncateProjectDocPreview(content, 20);
    expect(preview).toContain("...[truncated]");
  });
});
