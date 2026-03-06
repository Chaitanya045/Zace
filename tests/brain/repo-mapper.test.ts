import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInitialRepoMapMarkdown } from "../../src/brain/repo-mapper";

describe("repo mapper", () => {
  test("builds a bounded workspace seed map from generic workspace heuristics", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-repo-map-"));

    try {
      await mkdir(join(workspaceRoot, "apps", "web"), { recursive: true });
      await mkdir(join(workspaceRoot, "packages", "shared"), { recursive: true });
      await mkdir(join(workspaceRoot, "scripts"), { recursive: true });
      await mkdir(join(workspaceRoot, "tests", "unit"), { recursive: true });
      await mkdir(join(workspaceRoot, "python", "helpers"), { recursive: true });
      await mkdir(join(workspaceRoot, "node_modules", "left-pad"), { recursive: true });
      await mkdir(join(workspaceRoot, ".git", "objects"), { recursive: true });
      await mkdir(join(workspaceRoot, ".zace", "runtime"), { recursive: true });
      await mkdir(join(workspaceRoot, "dist"), { recursive: true });
      await mkdir(join(workspaceRoot, "build"), { recursive: true });
      await mkdir(join(workspaceRoot, "vendor"), { recursive: true });
      await writeFile(
        join(workspaceRoot, "AGENTS.md"),
        "Acme Control Plane is a multi-package workspace for automation workflows.\n",
        "utf8"
      );
      await writeFile(
        join(workspaceRoot, "README.md"),
        "It uses TypeScript services with a small Python helper layer.\n",
        "utf8"
      );
      await writeFile(join(workspaceRoot, "package.json"), "{\n  \"name\": \"acme-control-plane\"\n}\n", "utf8");
      await writeFile(join(workspaceRoot, "tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n", "utf8");
      await writeFile(join(workspaceRoot, ".env.example"), "OPENROUTER_API_KEY=\n", "utf8");
      await writeFile(join(workspaceRoot, "apps", "web", "index.tsx"), "export {};\n", "utf8");
      await writeFile(join(workspaceRoot, "packages", "shared", "index.ts"), "export {};\n", "utf8");
      await writeFile(join(workspaceRoot, "python", "helpers", "app.py"), "print('acme')\n", "utf8");

      const repoMap = await buildInitialRepoMapMarkdown(workspaceRoot);

      expect(repoMap).toContain("Bootstrap seed generated from repository docs and a bounded workspace scan.");
      expect(repoMap).toContain("`AGENTS.md` - repository operating instructions for coding agents");
      expect(repoMap).toContain("Acme Control Plane is a multi-package workspace for automation workflows.");
      expect(repoMap).toContain("`apps/` - primary source area");
      expect(repoMap).toContain("`apps/web/` - frontend or client module area");
      expect(repoMap).toContain("`packages/shared/` - source module area");
      expect(repoMap).toContain("`tests/` - test or fixture area");
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
