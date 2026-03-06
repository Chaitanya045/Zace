import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureBrainStructure } from "../../src/brain";

describe("brain bootstrap", () => {
  test("creates the filesystem brain with seeded documents", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-bootstrap-"));

    try {
      await mkdir(join(workspaceRoot, "apps", "api"), { recursive: true });
      await mkdir(join(workspaceRoot, "packages", "shared"), { recursive: true });
      await mkdir(join(workspaceRoot, "tests", "unit"), { recursive: true });
      await writeFile(join(workspaceRoot, "apps", "api", "index.ts"), "export {};\n", "utf8");
      await writeFile(join(workspaceRoot, "AGENTS.md"), [
        "# AGENTS",
        "",
        "Acme Control Plane is a multi-package workspace built with TypeScript.",
        "- It provides automation services and a shared library.",
        "- Changes should remain small and reviewable.",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(workspaceRoot, "README.md"), [
        "# README",
        "",
        "The repository includes an API app, shared packages, and automated tests.",
        "- It uses a bounded bootstrap scan to map the workspace.",
        "",
      ].join("\n"), "utf8");

      const result = await ensureBrainStructure({ workspaceRoot });

      expect(result.createdDirectories.length).toBeGreaterThan(0);
      expect(result.createdFiles).toContain(".zace/brain/identity.md");
      expect(result.createdFiles).toContain(".zace/working_memory.json");

      const identity = await readFile(join(workspaceRoot, ".zace", "brain", "identity.md"), "utf8");
      expect(identity).toContain("precise, disciplined, and safety-first coding agent");
      expect(identity).toContain("Acme Control Plane is a multi-package workspace built with TypeScript.");

      const repoMap = await readFile(join(workspaceRoot, ".zace", "brain", "repo_map.md"), "utf8");
      expect(repoMap).toContain("`apps/api/` - backend or service module area");
      expect(repoMap).toContain("`packages/shared/` - source module area");

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

  test("uses generic repository-summary fallback when docs are absent", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-generic-summary-"));

    try {
      await mkdir(join(workspaceRoot, "cmd"), { recursive: true });
      await mkdir(join(workspaceRoot, "internal", "service"), { recursive: true });
      await writeFile(join(workspaceRoot, "go.mod"), "module example.com/acme\n", "utf8");

      await ensureBrainStructure({ workspaceRoot });

      const identity = await readFile(join(workspaceRoot, ".zace", "brain", "identity.md"), "utf8");
      expect(identity).toContain("Detected root manifests: `go.mod`.");
      expect(identity).toContain("Primary workspace areas:");
      expect(identity).toContain("`cmd/`");
      expect(identity).toContain("`internal/`");
      expect(identity).not.toContain("Zace is a CLI coding agent built with Bun + TypeScript.");
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
