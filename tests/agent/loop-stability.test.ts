import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  buildToolCallSignature,
  detectPreExecutionDoomLoop,
  detectStagnation,
} from "../../src/agent/stability";

describe("loop stability", () => {
  test("pre-exec doom loop blocks repeated identical call at threshold", () => {
    const repeatedSignature = buildToolCallSignature("execute_command", {
      command: "echo hi",
      cwd: "/repo",
    });

    const detection = detectPreExecutionDoomLoop({
      historySignatures: [repeatedSignature, repeatedSignature],
      nextSignature: repeatedSignature,
      threshold: 3,
    });

    expect(detection.shouldBlock).toBe(true);
    expect(detection.repeatedCount).toBe(3);
  });

  test("pre-exec doom loop treats absolute and relative inspect commands as identical", () => {
    const repositoryRoot = resolve("/tmp/zace-loop-root");
    const relativeSignature = buildToolCallSignature("execute_command", {
      command: "ls -la src/",
      cwd: repositoryRoot,
    });
    const absoluteSignature = buildToolCallSignature("execute_command", {
      command: `ls -la ${repositoryRoot}/src`,
      cwd: repositoryRoot,
    });

    const detection = detectPreExecutionDoomLoop({
      historySignatures: [relativeSignature, absoluteSignature],
      nextSignature: relativeSignature,
      threshold: 3,
    });

    expect(relativeSignature).toBe(absoluteSignature);
    expect(detection.shouldBlock).toBe(true);
    expect(detection.repeatedCount).toBe(3);
  });

  test("progress signals prevent stagnation classification", () => {
    const stagnation = detectStagnation({
      steps: [
        {
          reasoning: "step one",
          state: "executing",
          step: 1,
          toolCall: { arguments: { command: "echo hi" }, name: "execute_command" },
          toolResult: { artifacts: { progressSignal: "files_changed" }, output: "updated", success: true },
        },
        {
          reasoning: "step two",
          state: "executing",
          step: 2,
          toolCall: { arguments: { command: "echo hi" }, name: "execute_command" },
          toolResult: { artifacts: { progressSignal: "success_without_changes" }, output: "more output", success: true },
        },
      ],
      window: 2,
    });

    expect(stagnation.isStagnant).toBe(false);
  });
});
