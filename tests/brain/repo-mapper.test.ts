import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInitialRepoMapMarkdown } from "../../src/brain/repo-mapper";

describe("repo mapper", () => {
  test("builds a bounded workspace seed map and skips generated or vendor directories", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-repo-map-"));

    try {
      await mkdir(join(workspaceRoot, "src", "agent"), { recursive: true });
      await mkdir(join(workspaceRoot, "src", "tools"), { recursive: true });
      await mkdir(join(workspaceRoot, "tests", "unit"), { recursive: true });
      await mkdir(join(workspaceRoot, "python", "zace_tui"), { recursive: true });
      await mkdir(join(workspaceRoot, "node_modules", "left-pad"), { recursive: true });
      await mkdir(join(workspaceRoot, ".git", "objects"), { recursive: true });
      await mkdir(join(workspaceRoot, ".zace", "runtime"), { recursive: true });
      await mkdir(join(workspaceRoot, "dist"), { recursive: true });
      await mkdir(join(workspaceRoot, "build"), { recursive: true });
      await mkdir(join(workspaceRoot, "vendor"), { recursive: true });
      await writeFile(join(workspaceRoot, "AGENTS.md"), "Zace is a CLI coding agent.\n", "utf8");
      await writeFile(join(workspaceRoot, "README.md"), "Planner-executor loop.\n", "utf8");
      await writeFile(join(workspaceRoot, "package.json"), "{\n  \"name\": \"zace\"\n}\n", "utf8");
      await writeFile(join(workspaceRoot, "tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n", "utf8");
      await writeFile(join(workspaceRoot, ".env.example"), "OPENROUTER_API_KEY=\n", "utf8");
      await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");
      await writeFile(join(workspaceRoot, "python", "zace_tui", "app.py"), "print('zace')\n", "utf8");

      const repoMap = await buildInitialRepoMapMarkdown(workspaceRoot);

      expect(repoMap).toContain("Bootstrap seed generated from repository docs and a bounded workspace scan.");
      expect(repoMap).toContain("`AGENTS.md` - repository operating instructions for coding agents");
      expect(repoMap).toContain("`src/agent/` - runtime orchestration and loop phases");
      expect(repoMap).toContain("`tests/` - automated test coverage and regression fixtures");
      expect(repoMap).toContain("`python/zace_tui/` - Textual UI package and rendering logic");
      expect(repoMap).not.toContain("`node_modules/`");
      expect(repoMap).not.toContain("`.git/`");
      expect(repoMap).not.toContain("`.zace/`");
      expect(repoMap).not.toContain("`dist/`");
      expect(repoMap).not.toContain("`build/`");
      expect(repoMap).not.toContain("`vendor/`");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
