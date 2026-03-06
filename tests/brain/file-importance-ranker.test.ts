import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureBrainStructure,
  recomputeTouchedFileImportance,
} from "../../src/brain";

describe("file importance ranker", () => {
  test("scores touched files from edit frequency, graph links, and recent task relevance", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-file-importance-"));

    try {
      await ensureBrainStructure({ workspaceRoot });
      await writeFile(join(workspaceRoot, ".zace", "file_importance.json"), JSON.stringify({
        "src/legacy.ts": 0.42,
      }, null, 2) + "\n", "utf8");

      const graphNodes = [
        {
          filePath: "src/auth.ts",
          id: "file:src-auth-ts",
          label: "src/auth.ts",
          type: "file",
          updatedAt: new Date().toISOString(),
        },
        {
          filePath: "src/utils.ts",
          id: "file:src-utils-ts",
          label: "src/utils.ts",
          type: "file",
          updatedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          description: "auth bug",
          id: "bug:auth",
          label: "auth bug",
          type: "bug",
          updatedAt: new Date().toISOString(),
        },
        {
          description: "auth decision",
          id: "decision:auth",
          label: "auth decision",
          type: "decision",
          updatedAt: new Date().toISOString(),
        },
      ] as const;
      const graphEdges = [
        {
          from: "session:a",
          to: "file:src-auth-ts",
          type: "modified_in_session",
          updatedAt: new Date().toISOString(),
          weight: 1,
        },
        {
          from: "session:b",
          to: "file:src-auth-ts",
          type: "modified_in_session",
          updatedAt: new Date().toISOString(),
          weight: 1,
        },
        {
          from: "session:c",
          to: "file:src-auth-ts",
          type: "inspected_in_session",
          updatedAt: new Date().toISOString(),
          weight: 1,
        },
        {
          from: "bug:auth",
          to: "file:src-auth-ts",
          type: "related_to_file",
          updatedAt: new Date().toISOString(),
          weight: 2,
        },
        {
          from: "decision:auth",
          to: "file:src-auth-ts",
          type: "related_to_file",
          updatedAt: new Date().toISOString(),
          weight: 2,
        },
        {
          from: "session:d",
          to: "file:src-utils-ts",
          type: "inspected_in_session",
          updatedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
          weight: 1,
        },
      ] as const;

      const scores = await recomputeTouchedFileImportance({
        changedFiles: ["src/auth.ts"],
        graphEdges: [...graphEdges],
        graphNodes: [...graphNodes],
        touchedFiles: ["src/auth.ts", "src/utils.ts"],
        workspaceRoot,
      });

      expect(scores["src/auth.ts"]).toBeGreaterThan(scores["src/utils.ts"] ?? 0);
      expect(scores["src/auth.ts"]).toBeGreaterThan(0.5);
      expect(scores["src/legacy.ts"]).toBe(0.42);

      const persistedScores = JSON.parse(
        await readFile(join(workspaceRoot, ".zace", "file_importance.json"), "utf8")
      ) as Record<string, number>;
      expect(persistedScores["src/auth.ts"]).toBe(scores["src/auth.ts"]);
      expect(persistedScores["src/legacy.ts"]).toBe(0.42);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
