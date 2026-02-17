import { describe, expect, test } from "bun:test";

import {
  buildToolCallSignature,
  detectPreExecutionDoomLoop,
  detectStagnation,
} from "../../src/agent/stability";

describe("agent stability helpers", () => {
  test("buildToolCallSignature is stable across object key order", () => {
    const signatureA = buildToolCallSignature("execute_command", {
      command: "echo hello",
      cwd: "/repo",
    });
    const signatureB = buildToolCallSignature("execute_command", {
      command: "echo hello",
      cwd: "/repo",
    });

    expect(signatureA).toBe(signatureB);
  });

  test("detects pre-execution doom loop on repeated signatures", () => {
    const detection = detectPreExecutionDoomLoop({
      historySignatures: ["a", "b", "b"],
      nextSignature: "b",
      threshold: 3,
    });

    expect(detection.repeatedCount).toBe(3);
    expect(detection.shouldBlock).toBe(true);
  });

  test("detects stagnation when recent tool calls have no progress", () => {
    const stagnation = detectStagnation({
      steps: [
        {
          reasoning: "step one",
          state: "executing",
          step: 1,
          toolCall: { arguments: { command: "echo hi" }, name: "execute_command" },
          toolResult: { artifacts: { progressSignal: "success_without_changes" }, output: "ok", success: true },
        },
        {
          reasoning: "step two",
          state: "executing",
          step: 2,
          toolCall: { arguments: { command: "echo hi" }, name: "execute_command" },
          toolResult: { artifacts: { progressSignal: "none" }, output: "ok", success: true },
        },
      ],
      window: 2,
    });

    expect(stagnation.isStagnant).toBe(true);
    expect(stagnation.reason).toContain("did not produce observable progress");
  });
});
