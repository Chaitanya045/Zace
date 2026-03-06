import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureBrainStructure, persistPlannerState } from "../../src/brain";

describe("task planner persistence", () => {
  test("archives completed steps and keeps only active plan steps", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-task-planner-"));

    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
      await ensureBrainStructure({ workspaceRoot });

      await persistPlannerState({
        action: "continue",
        planState: {
          currentStepId: "step-2",
          goal: "implement auth flow",
          steps: [
            {
              id: "step-1",
              relevantFiles: ["src/auth.ts"],
              status: "completed",
              title: "Inspect existing auth flow",
            },
            {
              id: "step-2",
              relevantFiles: ["src/auth.ts", "src/session.ts"],
              status: "in_progress",
              title: "Patch token validation",
            },
          ],
        },
        workspaceRoot,
      });

      const currentPlan = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "planner", "current_plan.json"), "utf8")
      ) as {
        currentStepId: null | string;
        goal: null | string;
        steps: Array<{ id: string; status: string }>;
      };
      const completedTasks = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "planner", "completed_tasks.json"), "utf8")
      ) as Array<{ goal: null | string; stepId: string; title: string }>;

      expect(currentPlan.goal).toBe("implement auth flow");
      expect(currentPlan.currentStepId).toBe("step-2");
      expect(currentPlan.steps.map((step) => step.id)).toEqual(["step-2"]);
      expect(completedTasks).toHaveLength(1);
      expect(completedTasks[0]?.stepId).toBe("step-1");
      expect(completedTasks[0]?.goal).toBe("implement auth flow");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test("completion action archives remaining steps and clears current plan", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-task-planner-complete-"));

    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
      await ensureBrainStructure({ workspaceRoot });
      await writeFile(join(workspaceRoot, ".zace", "planner", "current_plan.json"), JSON.stringify({
        currentStepId: "step-2",
        goal: "implement auth flow",
        steps: [
          {
            id: "step-2",
            relevantFiles: ["src/auth.ts"],
            status: "in_progress",
            title: "Patch token validation",
          },
          {
            id: "step-3",
            relevantFiles: ["tests/auth.test.ts"],
            status: "pending",
            title: "Add regression tests",
          },
        ],
        updatedAt: "2026-03-06T12:00:00.000Z",
      }, null, 2) + "\n", "utf8");

      await persistPlannerState({
        action: "complete",
        workspaceRoot,
      });

      const currentPlan = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "planner", "current_plan.json"), "utf8")
      ) as {
        currentStepId: null | string;
        goal: null | string;
        steps: Array<{ id: string }>;
      };
      const completedTasks = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "planner", "completed_tasks.json"), "utf8")
      ) as Array<{ stepId: string }>;

      expect(currentPlan.goal).toBeNull();
      expect(currentPlan.currentStepId).toBeNull();
      expect(currentPlan.steps).toEqual([]);
      expect(completedTasks.map((task) => task.stepId)).toEqual(["step-2", "step-3"]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
