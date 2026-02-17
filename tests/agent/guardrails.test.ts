import { describe, expect, test } from "bun:test";

import {
  buildToolLoopSignature,
  createRepoGroundingState,
  getLanguageMismatchReason,
  isLikelyWriteCommand,
  recordCommandObservation,
  shouldRunReconBeforeCommand,
} from "../../src/agent/guardrails";

describe("agent guardrails", () => {
  test("detects likely write commands", () => {
    expect(isLikelyWriteCommand("cat > fibonacci.py <<'EOF'")).toBe(true);
    expect(isLikelyWriteCommand("ls -la")).toBe(false);
  });

  test("requests reconnaissance before first write command", () => {
    const initialState = createRepoGroundingState();
    expect(shouldRunReconBeforeCommand("touch hello.ts", initialState)).toBe(true);

    const observedState = recordCommandObservation({
      command: "ls -la",
      output: "package.json\ntsconfig.json",
      state: initialState,
      success: true,
    });
    expect(shouldRunReconBeforeCommand("touch hello.ts", observedState)).toBe(false);
  });

  test("flags python file write in typescript-first repo when user did not request python", () => {
    const initialState = createRepoGroundingState();
    const observedState = recordCommandObservation({
      command: "ls -la",
      output: "package.json\ntsconfig.json\nbun.lock",
      state: initialState,
      success: true,
    });

    const mismatch = getLanguageMismatchReason({
      command: "cat > fibonacci.py <<'EOF'\nprint(1)\nEOF",
      state: observedState,
      task: "create fibonacci code in root",
    });
    expect(mismatch).not.toBeNull();
  });

  test("normalizes artifact-specific values in tool loop signatures", () => {
    const signatureA = buildToolLoopSignature({
      argumentsObject: {
        command: "echo hello",
      },
      output:
        "[artifacts]\nstdout: /tmp/11111111-1111-4111-8111-111111111111.stdout.log\nstderr: /tmp/11111111-1111-4111-8111-111111111111.stderr.log",
      success: true,
      toolName: "execute_command",
    });
    const signatureB = buildToolLoopSignature({
      argumentsObject: {
        command: "echo hello",
      },
      output:
        "[artifacts]\nstdout: /tmp/22222222-2222-4222-8222-222222222222.stdout.log\nstderr: /tmp/22222222-2222-4222-8222-222222222222.stderr.log",
      success: true,
      toolName: "execute_command",
    });

    expect(signatureA).toBe(signatureB);
  });
});
