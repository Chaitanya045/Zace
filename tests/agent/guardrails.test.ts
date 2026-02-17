import { describe, expect, test } from "bun:test";

import { buildToolLoopSignature } from "../../src/agent/guardrails";

describe("agent guardrails", () => {
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

  test("changes signature when command arguments differ", () => {
    const signatureA = buildToolLoopSignature({
      argumentsObject: {
        command: "echo hello",
      },
      output: "ok",
      success: true,
      toolName: "execute_command",
    });
    const signatureB = buildToolLoopSignature({
      argumentsObject: {
        command: "echo bye",
      },
      output: "ok",
      success: true,
      toolName: "execute_command",
    });

    expect(signatureA).not.toBe(signatureB);
  });
});
