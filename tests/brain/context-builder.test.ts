import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBrainContextMessage, ensureBrainStructure } from "../../src/brain";

async function seedBrainWorkspace(workspaceRoot: string): Promise<void> {
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "# Zace\n\nZace is a CLI coding agent built with Bun + TypeScript.\n", "utf8");
  await ensureBrainStructure({ workspaceRoot });

  await writeFile(join(workspaceRoot, ".zace", "brain", "knowledge.md"), [
    "# Knowledge Memory",
    "",
    "Authentication uses JWT bearer tokens.",
    "Redis is used for short-lived cache entries.",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, ".zace", "brain", "decisions.md"), [
    "# Decision Memory",
    "",
    "Decision: Keep auth logic in src/auth.ts",
    "Reason: Centralize token validation.",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, ".zace", "working_memory.json"), JSON.stringify({
    activePlanStepId: "step-1",
    currentStep: "inspect auth.ts",
    goal: "fix login bug",
    lastUpdatedAt: "2026-03-06T12:00:00.000Z",
    recentDecisions: ["Keep auth logic in src/auth.ts"],
    relevantFiles: ["src/auth.ts"],
    sessionId: "chat-test",
  }, null, 2) + "\n", "utf8");
  await writeFile(join(workspaceRoot, ".zace", "planner", "current_plan.json"), JSON.stringify({
    currentStepId: "step-1",
    goal: "fix login bug",
    steps: [
      {
        id: "step-1",
        relevantFiles: ["src/auth.ts"],
        status: "in_progress",
        title: "Inspect auth token validation",
      },
    ],
    updatedAt: "2026-03-06T12:00:00.000Z",
  }, null, 2) + "\n", "utf8");
  await writeFile(join(workspaceRoot, ".zace", "memory_graph", "nodes.json"), JSON.stringify([
    {
      description: "null token validation issue",
      filePath: "src/auth.ts",
      id: "auth_bug_2026",
      label: "Login null token bug",
      type: "bug",
      updatedAt: "2026-03-06T12:00:00.000Z",
    },
  ], null, 2) + "\n", "utf8");
  await writeFile(join(workspaceRoot, ".zace", "memory_graph", "edges.json"), JSON.stringify([
    {
      from: "auth_bug_2026",
      to: "src/auth.ts",
      type: "located_in",
      updatedAt: "2026-03-06T12:00:00.000Z",
      weight: 1,
    },
  ], null, 2) + "\n", "utf8");
  await writeFile(join(workspaceRoot, ".zace", "file_importance.json"), JSON.stringify({
    "src/auth.ts": 0.92,
    "src/cache.ts": 0.61,
    "src/ui.ts": 0.10,
  }, null, 2) + "\n", "utf8");
  await writeFile(join(workspaceRoot, ".zace", "episodic_memory", "session_logs", "session_one.md"), [
    "# Session",
    "",
    "Session goal: fix login bug",
    "Discovered invalid auth token handling in src/auth.ts",
    "",
  ].join("\n"), "utf8");
}

describe("brain context builder", () => {
  test("builds bounded context with retrieved snippets and important files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-context-"));

    try {
      await seedBrainWorkspace(workspaceRoot);

      const result = await buildBrainContextMessage({
        callKind: "planner",
        maxImportantFiles: 2,
        maxRetrievedSnippets: 3,
        query: "fix login bug in auth token validation",
        relevantFiles: ["src/auth.ts"],
        workspaceRoot,
      });

      expect(result.message.content).toContain("PERSISTENT BRAIN CONTEXT (PLANNER)");
      expect(result.message.content).toContain("[identity]");
      expect(result.message.content).toContain("[working_memory]");
      expect(result.message.content).toContain("[current_plan]");
      expect(result.message.content).toContain("Login null token bug");
      expect(result.message.content).toContain("[important_files]");
      expect(result.importantFiles).toHaveLength(2);
      expect(result.importantFiles[0]?.path).toBe("src/auth.ts");
      expect(result.retrievedSnippets.length).toBeLessThanOrEqual(3);
      expect(result.keywords).toContain("login");

      const workingMemory = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "working_memory.json"), "utf8")
      ) as Record<string, unknown>;
      expect(workingMemory.goal).toBe("fix login bug");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
