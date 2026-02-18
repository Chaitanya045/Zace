import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessValidationGateMasking,
  describeCompletionPlan,
  discoverAutomaticCompletionGates,
  resolveCompletionPlan,
} from "../../src/agent/completion";

describe("completion plan resolution", () => {
  test("defaults to planner-driven gates when task has no explicit criteria", () => {
    const plan = resolveCompletionPlan("Implement feature X");
    expect(plan.gates).toEqual([]);
    expect(plan.source).toBe("none");
  });

  test("parses explicit DONE_CRITERIA task spec for compatibility", () => {
    const plan = resolveCompletionPlan(
      "Implement feature X\nDONE_CRITERIA: cmd:bun lint;;cmd:bun test"
    );

    expect(plan.source).toBe("task_explicit");
    expect(plan.gates).toEqual([
      {
        command: "bun lint",
        label: "gate:1",
      },
      {
        command: "bun test",
        label: "gate:2",
      },
    ]);
  });

  test("describeCompletionPlan explains planner-provided default behavior", () => {
    const lines = describeCompletionPlan({
      gates: [],
      source: "none",
    });

    expect(lines.some((line) => line.includes("Planner should provide gates"))).toBe(true);
  });

  test("detects masked validation gate commands", () => {
    const masked = assessValidationGateMasking("bun test || true");
    const safe = assessValidationGateMasking("bun test");

    expect(masked.isMasked).toBe(true);
    expect(masked.reason).toContain("|| true");
    expect(safe.isMasked).toBe(false);
  });

  test("auto-discovers lint/test gates from package scripts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "zace-auto-gates-package-"));
    try {
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify(
          {
            packageManager: "bun@1.3.0",
            scripts: {
              lint: "eslint .",
              test: "bun test",
            },
          },
          null,
          2
        ),
        "utf8"
      );
      await writeFile(join(workspace, "bun.lock"), "", "utf8");

      const gates = await discoverAutomaticCompletionGates(workspace);
      expect(gates).toEqual([
        {
          command: "bun run lint",
          label: "auto:lint",
        },
        {
          command: "bun run test",
          label: "auto:test",
        },
      ]);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  test("falls back to make targets when package scripts are absent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "zace-auto-gates-make-"));
    try {
      await writeFile(
        join(workspace, "Makefile"),
        [
          "lint:",
          "\t@echo lint",
          "",
          "test:",
          "\t@echo test",
          "",
        ].join("\n"),
        "utf8"
      );

      const gates = await discoverAutomaticCompletionGates(workspace);
      expect(gates).toEqual([
        {
          command: "make lint",
          label: "auto:lint:make",
        },
        {
          command: "make test",
          label: "auto:test:make",
        },
      ]);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});
