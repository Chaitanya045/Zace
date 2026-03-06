import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureBrainStructure } from "../../src/brain";

describe("brain bootstrap", () => {
  test("creates the filesystem brain with seeded documents", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-bootstrap-"));

    try {
      await mkdir(join(workspaceRoot, "src", "agent"), { recursive: true });
      await mkdir(join(workspaceRoot, "src", "tools"), { recursive: true });
      await mkdir(join(workspaceRoot, "src", "ui"), { recursive: true });
      await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");
      await writeFile(join(workspaceRoot, "AGENTS.md"), [
        "# AGENTS",
        "",
        "Zace is a CLI coding agent built with Bun + TypeScript.",
        "- Planner-executor loop with strict tool boundaries.",
        "- All side effects go through typed tools.",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(workspaceRoot, "README.md"), [
        "# README",
        "",
        "Zace is a CLI coding agent built with Bun + TypeScript.",
        "- Textual-based Python chat UI with a Bun bridge over stdio JSON-RPC.",
        "",
      ].join("\n"), "utf8");

      const result = await ensureBrainStructure({ workspaceRoot });

      expect(result.createdDirectories.length).toBeGreaterThan(0);
      expect(result.createdFiles).toContain(".zace/brain/identity.md");
      expect(result.createdFiles).toContain(".zace/working_memory.json");

      const identity = await readFile(join(workspaceRoot, ".zace", "brain", "identity.md"), "utf8");
      expect(identity).toContain("precise, disciplined, and safety-first coding agent");
      expect(identity).toContain("Zace is a CLI coding agent built with Bun + TypeScript.");

      const repoMap = await readFile(join(workspaceRoot, ".zace", "brain", "repo_map.md"), "utf8");
      expect(repoMap).toContain("`src/agent/` - runtime orchestration and loop phases");
      expect(repoMap).toContain("`src/tools/` - side-effect boundary and system wrappers");

      const workingMemory = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "working_memory.json"), "utf8")
      ) as Record<string, unknown>;
      expect(workingMemory.goal).toBeNull();
      expect(workingMemory.relevantFiles).toEqual([]);

      const currentPlan = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "planner", "current_plan.json"), "utf8")
      ) as Record<string, unknown>;
      expect(currentPlan.goal).toBeNull();
      expect(currentPlan.steps).toEqual([]);

      const completedTasks = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "planner", "completed_tasks.json"), "utf8")
      ) as unknown[];
      expect(completedTasks).toEqual([]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test("preserves existing brain files on repeated bootstrap", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-preserve-"));

    try {
      await mkdir(join(workspaceRoot, ".zace", "brain"), { recursive: true });
      await writeFile(join(workspaceRoot, ".zace", "brain", "identity.md"), "# Custom Identity\n", "utf8");

      const result = await ensureBrainStructure({ workspaceRoot });

      const identity = await readFile(join(workspaceRoot, ".zace", "brain", "identity.md"), "utf8");
      expect(identity).toBe("# Custom Identity\n");
      expect(result.createdFiles).not.toContain(".zace/brain/identity.md");
      expect(result.createdFiles).toContain(".zace/brain/knowledge.md");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
