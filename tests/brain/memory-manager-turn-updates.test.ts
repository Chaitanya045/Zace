import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureBrainStructure,
  initializeTurnWorkingMemory,
  persistPlannerState,
  recordPlannerTransition,
  recordToolTransition,
} from "../../src/brain";

describe("brain turn updates", () => {
  test("updates working memory and incremental brain artifacts during planner and tool transitions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-turn-updates-"));

    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
      await ensureBrainStructure({ workspaceRoot });

      await initializeTurnWorkingMemory({
        sessionId: "chat-turn-updates",
        task: "fix auth bug",
        workspaceRoot,
      });
      await persistPlannerState({
        action: "continue",
        planState: {
          currentStepId: "step-1",
          goal: "fix auth bug",
          steps: [
            {
              id: "step-1",
              relevantFiles: ["src/auth.ts"],
              status: "in_progress",
              title: "Inspect auth token validation",
            },
          ],
        },
        workspaceRoot,
      });
      await recordPlannerTransition({
        action: "continue",
        planReasoning: "Inspect auth bug flow and patch token validation.",
        planState: {
          currentStepId: "step-1",
          goal: "fix auth bug",
          steps: [
            {
              id: "step-1",
              relevantFiles: ["src/auth.ts"],
              status: "in_progress",
              title: "Inspect auth token validation",
            },
          ],
        },
        sessionId: "chat-turn-updates",
        task: "fix auth bug",
        workspaceRoot,
      });
      await writeFile(join(workspaceRoot, "src", "auth.ts"), "export const auth = true;\n", "utf8");
      await recordToolTransition({
        changedFiles: [join(workspaceRoot, "src", "auth.ts")],
        planReasoning: "Fix auth bug by patching token validation.",
        sessionId: "chat-turn-updates",
        task: "fix auth bug",
        toolName: "bash",
        toolResult: {
          artifacts: {
            changedFiles: [join(workspaceRoot, "src", "auth.ts")],
          },
          output: "patched auth.ts",
          success: true,
        },
        workspaceRoot,
      });

      const workingMemory = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "working_memory.json"), "utf8")
      ) as {
        activePlanStepId: null | string;
        currentStep: null | string;
        goal: null | string;
        relevantFiles: string[];
        sessionId: null | string;
      };
      const repoMap = await readFile(join(workspaceRoot, ".zace", "brain", "repo_map.md"), "utf8");
      const nodes = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "memory_graph", "nodes.json"), "utf8")
      ) as Array<{ filePath?: string; id: string; type: string }>;
      const edges = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "memory_graph", "edges.json"), "utf8")
      ) as Array<{ from: string; to: string; type: string }>;
      const fileImportance = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "file_importance.json"), "utf8")
      ) as Record<string, number>;

      expect(workingMemory.goal).toBe("fix auth bug");
      expect(workingMemory.sessionId).toBe("chat-turn-updates");
      expect(workingMemory.activePlanStepId).toBe("step-1");
      expect(workingMemory.currentStep).toContain("Inspect auth token validation");
      expect(workingMemory.relevantFiles).toContain("src/auth.ts");
      expect(repoMap).toContain("## Incremental Updates");
      expect(repoMap).toContain("`src/auth.ts` - TypeScript source file; updated during agent execution.");
      expect(nodes.some((node) => node.filePath === "src/auth.ts" && node.type === "file")).toBeTrue();
      expect(nodes.some((node) => node.type === "bug")).toBeTrue();
      expect(edges.some((edge) => edge.type === "modified_in_session")).toBeTrue();
      expect(fileImportance["src/auth.ts"]).toBeGreaterThan(0);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
