import { describe, expect, test } from "bun:test";

import {
  buildLspBootstrapRequirementMessage,
  deriveLspBootstrapSignal,
} from "../../src/agent/loop";

describe("lsp bootstrap helpers", () => {
  test("marks no_active_server as required", () => {
    const signal = deriveLspBootstrapSignal({
      artifacts: {
        lspStatus: "no_active_server",
      },
      output: "[lsp]\nNo active LSP server for changed files.",
      success: true,
    });

    expect(signal).toBe("required");
  });

  test("marks diagnostics and no_errors as active", () => {
    const diagnosticsSignal = deriveLspBootstrapSignal({
      artifacts: {
        lspStatus: "diagnostics",
      },
      output: "[lsp]\nchanged_files: 1\ndiagnostic_files: 1",
      success: true,
    });
    const noErrorsSignal = deriveLspBootstrapSignal({
      artifacts: {
        lspStatus: "no_errors",
      },
      output: "[lsp]\nNo error diagnostics reported for changed files.",
      success: true,
    });

    expect(diagnosticsSignal).toBe("active");
    expect(noErrorsSignal).toBe("active");
  });

  test("marks failed status as failed", () => {
    const signal = deriveLspBootstrapSignal({
      artifacts: {
        lspStatus: "failed",
      },
      output: "[lsp]\nstatus: failed",
      success: false,
    });

    expect(signal).toBe("failed");
  });

  test("treats no_applicable_files as neutral for bootstrap state", () => {
    const signal = deriveLspBootstrapSignal({
      artifacts: {
        lspStatus: "no_applicable_files",
      },
      output: "[lsp]\nstatus: no_applicable_files",
      success: true,
    });

    expect(signal).toBe("none");
  });

  test("builds actionable bootstrap message with changed file preview", () => {
    const message = buildLspBootstrapRequirementMessage(".zace/runtime/lsp/servers.json", [
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/a.ts",
    ]);

    expect(message).toContain(".zace/runtime/lsp/servers.json");
    expect(message).toContain("/repo/src/a.ts");
    expect(message).toContain("/repo/src/b.ts");
  });
});
