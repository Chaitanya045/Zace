import { describe, expect, test } from "bun:test";

import {
  resolveProjectDocsPolicy,
  selectProjectDocCandidates,
} from "../../src/agent/docs";

describe("targeted docs context selection", () => {
  test("selects AGENTS/README/CLAUDE with nearest-path priority", () => {
    const discovered = [
      "docs/guide.md",
      "nested/AGENTS.md",
      "README.md",
      "AGENTS.md",
      "workspace/CLAUDE.md",
    ];
    const policy = resolveProjectDocsPolicy("Implement core loop changes.", discovered);

    const selected = selectProjectDocCandidates({
      discoveredDocCandidates: discovered,
      maxFiles: 3,
      mode: "targeted",
      policy,
      task: "Implement core loop changes.",
    });

    expect(selected).toEqual([
      "AGENTS.md",
      "README.md",
      "workspace/CLAUDE.md",
    ]);
  });

  test("includes explicit doc references in targeted mode", () => {
    const discovered = [
      "docs/production-readiness-plan.md",
      "README.md",
    ];
    const policy = resolveProjectDocsPolicy(
      "Use docs/production-readiness-plan.md and README.md for guidance.",
      discovered
    );

    const selected = selectProjectDocCandidates({
      discoveredDocCandidates: discovered,
      maxFiles: 2,
      mode: "targeted",
      policy,
      task: "Use docs/production-readiness-plan.md and README.md for guidance.",
    });

    expect(selected).toEqual([
      "docs/production-readiness-plan.md",
      "README.md",
    ]);
  });

  test("returns no preload docs in off mode", () => {
    const discovered = ["AGENTS.md", "README.md", "CLAUDE.md"];
    const policy = resolveProjectDocsPolicy("Do normal work", discovered);

    const selected = selectProjectDocCandidates({
      discoveredDocCandidates: discovered,
      maxFiles: 3,
      mode: "off",
      policy,
      task: "Do normal work",
    });

    expect(selected).toEqual([]);
  });
});
