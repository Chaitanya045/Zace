import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureBrainStructure, searchMemory } from "../../src/brain";
import { extractMemorySearchKeywords } from "../../src/brain/memory-retriever";

describe("memory retriever", () => {
  test("ignores conversational filler when extracting memory search keywords", () => {
    expect(extractMemorySearchKeywords("please help me inspect auth tokens")).toEqual([
      "inspect",
      "auth",
      "tokens",
    ]);
  });

  test("limits episodic log search to a recent bounded window", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-memory-retriever-"));

    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "README.md"), "# Zace\n", "utf8");
      await ensureBrainStructure({ workspaceRoot });

      for (let day = 1; day <= 30; day += 1) {
        const paddedDay = String(day).padStart(2, "0");
        const marker = day === 1
          ? "outsidewindowkeyword"
          : day === 30
            ? "recentwindowkeyword"
            : "neutralkeyword";
        await writeFile(
          join(
            workspaceRoot,
            ".zace",
            "episodic_memory",
            "session_logs",
            `session_2026-01-${paddedDay}T00-00-00-000Z_chat_run.md`
          ),
          `# Session\n\nSession goal: probe memory retrieval\n${marker}\n`,
          "utf8"
        );
      }

      const oldSearch = await searchMemory({
        query: "outsidewindowkeyword",
        workspaceRoot,
      });
      const recentSearch = await searchMemory({
        query: "recentwindowkeyword",
        workspaceRoot,
      });

      expect(oldSearch.snippets).toHaveLength(0);
      expect(recentSearch.snippets.some((snippet) => snippet.content.includes("recentwindowkeyword"))).toBeTrue();
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
