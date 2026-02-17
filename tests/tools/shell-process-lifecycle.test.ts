import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSpawnedShellCommand, shellTools } from "../../src/tools/shell";

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolveSleep) => {
    setTimeout(resolveSleep, delayMs);
  });
}

async function waitForFile(pathValue: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await stat(pathValue);
      return;
    } catch {
      // keep waiting
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for file: ${pathValue}`);
}

function buildLifecycleCommand(parentScriptPath: string, childScriptPath: string, heartbeatPath: string): string {
  return [
    JSON.stringify(process.execPath),
    JSON.stringify(parentScriptPath),
    JSON.stringify(childScriptPath),
    JSON.stringify(heartbeatPath),
  ].join(" ");
}

let tempDirectoryPath = "";

afterEach(async () => {
  if (tempDirectoryPath) {
    await rm(tempDirectoryPath, { force: true, recursive: true });
    tempDirectoryPath = "";
  }
});

describe("shell process lifecycle", () => {
  test("timeout terminates process tree and emits timeout metadata", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-timeout-"));
    const childScriptPath = join(tempDirectoryPath, "child.cjs");
    const parentScriptPath = join(tempDirectoryPath, "parent.cjs");
    const heartbeatPath = join(tempDirectoryPath, "heartbeat-timeout.log");

    await writeFile(
      childScriptPath,
      [
        "const { appendFileSync } = require('node:fs');",
        "const targetPath = process.argv[2];",
        "setInterval(() => {",
        "  appendFileSync(targetPath, 'x');",
        "}, 40);",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      parentScriptPath,
      [
        "const { spawn } = require('node:child_process');",
        "const childScriptPath = process.argv[2];",
        "const targetPath = process.argv[3];",
        "spawn(process.execPath, [childScriptPath, targetPath], { stdio: 'ignore' });",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8"
    );

    const executeCommandTool = shellTools.find((tool) => tool.name === "execute_command");
    if (!executeCommandTool) {
      throw new Error("execute_command tool not found");
    }

    const result = await executeCommandTool.execute({
      command: buildLifecycleCommand(parentScriptPath, childScriptPath, heartbeatPath),
      cwd: tempDirectoryPath,
      timeout: 600,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.output).toContain("[execution]");
    expect(result.output).toContain("timed_out: true");
    expect(result.output).toContain("lifecycle_event: timeout");

    await waitForFile(heartbeatPath, 1_500);
    const firstStat = await stat(heartbeatPath);
    await sleep(350);
    const secondStat = await stat(heartbeatPath);
    expect(secondStat.size).toBe(firstStat.size);
  });

  test("abort signal terminates process tree and reports abort event", async () => {
    tempDirectoryPath = await mkdtemp(join(tmpdir(), "zace-shell-abort-"));
    const childScriptPath = join(tempDirectoryPath, "child.cjs");
    const parentScriptPath = join(tempDirectoryPath, "parent.cjs");
    const heartbeatPath = join(tempDirectoryPath, "heartbeat-abort.log");

    await writeFile(
      childScriptPath,
      [
        "const { appendFileSync } = require('node:fs');",
        "const targetPath = process.argv[2];",
        "setInterval(() => {",
        "  appendFileSync(targetPath, 'x');",
        "}, 40);",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      parentScriptPath,
      [
        "const { spawn } = require('node:child_process');",
        "const childScriptPath = process.argv[2];",
        "const targetPath = process.argv[3];",
        "spawn(process.execPath, [childScriptPath, targetPath], { stdio: 'ignore' });",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8"
    );

    const abortController = new globalThis.AbortController();
    setTimeout(() => {
      abortController.abort();
    }, 250);

    const execution = await runSpawnedShellCommand({
      abortSignal: abortController.signal,
      command: buildLifecycleCommand(parentScriptPath, childScriptPath, heartbeatPath),
      timeoutMs: 5_000,
      workingDirectory: tempDirectoryPath,
    });

    expect(execution.aborted).toBe(true);
    expect(execution.lifecycleEvent).toBe("abort");

    await waitForFile(heartbeatPath, 1_500);
    const firstStat = await stat(heartbeatPath);
    await sleep(350);
    const secondStat = await stat(heartbeatPath);
    expect(secondStat.size).toBe(firstStat.size);
  });
});
