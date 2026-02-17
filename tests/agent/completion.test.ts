import { describe, expect, test } from "bun:test";

import {
  assessValidationGateMasking,
  describeCompletionPlan,
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
});
