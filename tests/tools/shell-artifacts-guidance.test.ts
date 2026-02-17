import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";

import { shellTools } from "../../src/tools/shell";

describe("shell output truncation guidance", () => {
  test("includes actionable log-inspection hints when output is truncated", async () => {
    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    if (!executeCommandTool) {
      throw new Error("execute_command tool not found");
    }

    const result = await executeCommandTool.execute({
      command: `${JSON.stringify(process.execPath)} -e "console.log('x'.repeat(9000)); console.error('e'.repeat(9000));"`,
      outputLimitChars: 180,
      timeout: 30_000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[truncation]");
    expect(result.output).toContain("tail -n 200");
    expect(result.output).toContain("sed -n '1,200p'");
    expect(result.output).toContain("rg -n \"error|warn|fail|exception\"");

    expect(result.artifacts?.stdoutTruncated).toBe(true);
    expect(result.artifacts?.stderrTruncated).toBe(true);
    expect(result.artifacts?.stdoutPath).toBeDefined();
    expect(result.artifacts?.stderrPath).toBeDefined();
    expect(result.artifacts?.combinedPath).toBeDefined();

    if (result.artifacts?.stdoutPath && result.artifacts?.stderrPath && result.artifacts?.combinedPath) {
      await expect(stat(result.artifacts.stdoutPath)).resolves.toBeDefined();
      await expect(stat(result.artifacts.stderrPath)).resolves.toBeDefined();
      await expect(stat(result.artifacts.combinedPath)).resolves.toBeDefined();
    }
  });

  test("keeps execution command metadata compact for very long commands", async () => {
    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    if (!executeCommandTool) {
      throw new Error("execute_command tool not found");
    }

    const longComment = "x".repeat(1_500);
    const result = await executeCommandTool.execute({
      command: `echo ok # ${longComment}`,
      outputLimitChars: 500,
      timeout: 30_000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[execution]");
    expect(result.output).toContain("command:");
    expect(result.output).toContain("...[truncated ");
  });
});
