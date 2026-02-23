import { describe, expect, test } from "bun:test";

import type { LlmClient } from "../../src/llm/client";
import type { AgentConfig } from "../../src/types/config";

import {
  getDestructiveCommandReason,
  normalizeRuntimeScriptInvocation,
} from "../../src/agent/core/run-loop/command-safety";
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

  test("normalizes runtime script invocation from sh to bash", () => {
    const normalized = normalizeRuntimeScriptInvocation({
      command: "sh .zace/runtime/scripts/write-bst.sh",
      workingDirectory: "/repo",
    });

    expect(normalized.changed).toBe(true);
    expect(normalized.command).toBe("bash .zace/runtime/scripts/write-bst.sh");
  });

  test("does not require risky confirmation for runtime maintenance script overwrite", async () => {
    const reason = await getDestructiveCommandReason(
      {
        chat: async () => {
          throw new Error("safety model should not be called for runtime maintenance writes");
        },
      } as unknown as LlmClient,
      {
        requireRiskyConfirmation: true,
        riskyConfirmationToken: "ZACE_APPROVE_RISKY",
      } as AgentConfig,
      "cat > .zace/runtime/scripts/write-bst.sh <<'EOF'\necho hi\nEOF",
      {
        workingDirectory: "/repo",
      }
    );

    expect(reason).toBeNull();
  });
});
