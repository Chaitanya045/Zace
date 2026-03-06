import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureBrainStructure,
  recordCompactionMemory,
  recordTurnFinalization,
} from "../../src/brain";

describe("brain session logger", () => {
  test("persists episodic logs, durable knowledge, decisions, and artifact links", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-session-logger-"));

    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
      await writeFile(join(workspaceRoot, "src", "auth.ts"), "before\n", "utf8");
      const gitInitResult = Bun.spawnSync({
        cmd: ["git", "init", workspaceRoot],
        stderr: "pipe",
        stdout: "pipe",
      });
      const gitRepositoryAvailable = gitInitResult.exitCode === 0;
      await ensureBrainStructure({ workspaceRoot });

      const result = await recordTurnFinalization({
        assistantMessage: "Repository uses Bun and TypeScript.",
        compactionSummaryPaths: [".zace/summaries/existing-summary.md"],
        context: {
          currentStep: 1,
          fileSummaries: new Map<string, string>(),
          maxSteps: 4,
          scriptCatalog: new Map(),
          steps: [
            {
              reasoning: "Architectural decision: standardize auth validation.",
              state: "executing",
              step: 1,
              toolCall: {
                arguments: {
                  command: "echo patch",
                },
                name: "bash",
              },
              toolResult: {
                artifacts: {
                  changedFiles: [join(workspaceRoot, "src", "auth.ts")],
                },
                output: "patched auth.ts",
                success: true,
              },
            },
          ],
          task: "fix auth bug",
        },
        endedAt: new Date("2026-03-06T12:00:00.000Z"),
        finalReason: "completed",
        finalState: "completed",
        runId: "run-phase-5",
        sessionId: "chat-phase-5",
        startedAt: new Date("2026-03-06T11:59:00.000Z"),
        success: true,
        task: "fix auth bug",
        workspaceRoot,
      });

      const episodicLog = await readFile(join(workspaceRoot, result.episodicLogPath), "utf8");
      const knowledge = await readFile(join(workspaceRoot, ".zace", "brain", "knowledge.md"), "utf8");
      const decisions = await readFile(join(workspaceRoot, ".zace", "brain", "decisions.md"), "utf8");
      const nodes = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "memory_graph", "nodes.json"), "utf8")
      ) as Array<{ filePath?: string; type: string }>;
      const edges = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "memory_graph", "edges.json"), "utf8")
      ) as Array<{ to: string; type: string }>;

      expect(episodicLog).toContain("Session goal: fix auth bug");
      expect(episodicLog).toContain("src/auth.ts");
      expect(episodicLog).toContain(".zace/summaries/existing-summary.md");
      expect(knowledge).toContain("Repository uses Bun and TypeScript.");
      expect(decisions).toContain("Decision:");
      expect(decisions).toContain("Architectural decision: standardize auth validation.");
      expect(nodes.some((node) => node.filePath === result.episodicLogPath && node.type === "artifact")).toBeTrue();
      expect(edges.some((edge) => edge.to.includes("artifact:") && edge.type === "generated_artifact")).toBeTrue();

      if (gitRepositoryAvailable) {
        expect(result.gitArtifactPath).toBeDefined();
      }

      if (result.gitArtifactPath) {
        const gitArtifact = await readFile(join(workspaceRoot, result.gitArtifactPath), "utf8");
        expect(gitArtifact).toContain("# Git Change Artifact");
      }
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test("persists compaction summaries and links them into the memory graph", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-compaction-summary-"));

    try {
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
      await ensureBrainStructure({ workspaceRoot });

      const summaryPath = await recordCompactionMemory({
        relatedFiles: ["src/auth.ts"],
        runId: "run-compaction",
        sessionId: "chat-compaction",
        step: 2,
        summary: "## Goal\nContinue auth refactor.",
        workspaceRoot,
      });

      const summary = await readFile(join(workspaceRoot, summaryPath), "utf8");
      const nodes = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "memory_graph", "nodes.json"), "utf8")
      ) as Array<{ filePath?: string; type: string }>;
      const edges = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "memory_graph", "edges.json"), "utf8")
      ) as Array<{ type: string }>;

      expect(summary).toContain("# Compaction Summary");
      expect(summary).toContain("Continue auth refactor.");
      expect(nodes.some((node) => node.filePath === summaryPath && node.type === "artifact")).toBeTrue();
      expect(edges.some((edge) => edge.type === "generated_summary")).toBeTrue();
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
