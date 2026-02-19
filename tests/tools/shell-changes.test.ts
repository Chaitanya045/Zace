import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  buildExecuteCommandSignature,
  buildLspDiagnosticsOutput,
  detectCommandProgressSignal,
  deriveChangedFilesFromGitSnapshots,
  parseChangedFilesFromMarkerLines,
} from "../../src/tools/shell";

describe("shell changed-file and diagnostics helpers", () => {
  test("parses changed-file markers and normalizes paths", () => {
    const workingDirectory = "/tmp/zace-shell-markers";
    const parsed = parseChangedFilesFromMarkerLines(
      [
        "ZACE_SCRIPT_USE|helper",
        "ZACE_FILE_CHANGED|src/main.ts",
        "ZACE_FILE_CHANGED|\"src/main.ts\"",
        "ZACE_FILE_CHANGED|/tmp/zace-shell-markers/src/util.ts",
      ],
      workingDirectory
    );

    expect(parsed).toEqual([
      resolve(workingDirectory, "src/main.ts"),
      resolve(workingDirectory, "src/util.ts"),
    ]);
  });

  test("derives changed files from git snapshots using path delta", () => {
    const before = ["/repo/src/a.ts", "/repo/src/b.ts"];
    const after = ["/repo/src/b.ts", "/repo/src/c.ts"];

    const changed = deriveChangedFilesFromGitSnapshots(before, after);
    expect(changed).toEqual([resolve("/repo/src/c.ts")]);
  });

  test("derives changed files from git snapshots using fingerprint delta for already-dirty files", () => {
    const before = new Map([
      [
        "/repo/src/b.ts",
        {
          mtimeMs: 1000,
          size: 20,
        },
      ],
    ]);
    const after = new Map([
      [
        "/repo/src/b.ts",
        {
          mtimeMs: 2000,
          size: 22,
        },
      ],
    ]);

    const changed = deriveChangedFilesFromGitSnapshots(before, after);
    expect(changed).toEqual([resolve("/repo/src/b.ts")]);
  });

  test("builds a stable execute-command signature", () => {
    const signatureA = buildExecuteCommandSignature("echo hi", "/tmp/a/../repo");
    const signatureB = buildExecuteCommandSignature("echo hi", "/tmp/repo");

    expect(signatureA).toBe(signatureB);
  });

  test("detects command progress signals", () => {
    expect(
      detectCommandProgressSignal({
        changedFiles: ["/repo/src/a.ts"],
        stderr: "",
        stdout: "",
        success: true,
      })
    ).toBe("files_changed");
    expect(
      detectCommandProgressSignal({
        changedFiles: [],
        stderr: "",
        stdout: "updated",
        success: true,
      })
    ).toBe("success_without_changes");
    expect(
      detectCommandProgressSignal({
        changedFiles: [],
        stderr: "",
        stdout: "",
        success: true,
      })
    ).toBe("success_without_changes");
    expect(
      detectCommandProgressSignal({
        changedFiles: [],
        stderr: "error",
        stdout: "",
        success: false,
      })
    ).toBe("none");
  });

  test("formats capped LSP diagnostics output", () => {
    const changedFileA = resolve("/repo/src/a.ts");
    const changedFileB = resolve("/repo/src/b.ts");
    const changedFileC = resolve("/repo/src/c.ts");

    const diagnostics = buildLspDiagnosticsOutput({
      changedFiles: [changedFileA, changedFileB, changedFileC],
      diagnosticsByFile: {
        [changedFileA]: [
          {
            message: "A-1",
            range: {
              end: { character: 3, line: 0 },
              start: { character: 1, line: 0 },
            },
            severity: 1,
          },
          {
            message: "A-2",
            range: {
              end: { character: 4, line: 1 },
              start: { character: 1, line: 1 },
            },
            severity: 1,
          },
          {
            message: "A-3",
            range: {
              end: { character: 5, line: 2 },
              start: { character: 2, line: 2 },
            },
            severity: 1,
          },
        ],
        [changedFileB]: [
          {
            message: "B-1",
            range: {
              end: { character: 2, line: 3 },
              start: { character: 1, line: 3 },
            },
            severity: 1,
          },
        ],
      },
      maxDiagnosticsPerFile: 2,
      maxFilesInOutput: 1,
    });

    expect(diagnostics.errorCount).toBe(4);
    expect(diagnostics.diagnosticsFiles).toEqual([changedFileA, changedFileB]);
    expect(diagnostics.outputSection).toContain("[lsp]");
    expect(diagnostics.outputSection).toContain(`<diagnostics file="${changedFileA}">`);
    expect(diagnostics.outputSection).toContain("... and 1 more");
    expect(diagnostics.outputSection).toContain("... and 1 more files with diagnostics");
  });
});
