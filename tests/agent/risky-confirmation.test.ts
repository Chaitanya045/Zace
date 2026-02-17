import { describe, expect, test } from "bun:test";

import { extractOverwriteRedirectTargets } from "../../src/agent/loop";
import { buildCommandSafetyPrompt } from "../../src/prompts/safety";

describe("command safety remains LLM-driven with context facts", () => {
  test("extracts overwrite targets from shell redirection", () => {
    const targets = extractOverwriteRedirectTargets(
      "cat > bst.ts << 'EOF'\nconst value = 1;\nEOF"
    );
    expect(targets).toEqual(["bst.ts"]);
  });

  test("includes runtime file-context facts in safety prompt", () => {
    const prompt = buildCommandSafetyPrompt("cat > bst.ts << 'EOF'\nconst value = 1;\nEOF", {
      overwriteRedirectTargets: [
        {
          exists: "no",
          rawPath: "bst.ts",
          resolvedPath: "/repo/bst.ts",
        },
      ],
      workingDirectory: "/repo",
    });

    expect(prompt).toContain("EXECUTION CONTEXT FACTS");
    expect(prompt).toContain("\"rawPath\": \"bst.ts\"");
    expect(prompt).toContain("\"exists\": \"no\"");
    expect(prompt).toContain("Use the provided context facts when deciding");
  });
});
