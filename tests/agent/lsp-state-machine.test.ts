import { describe, expect, test } from "bun:test";

import { advanceLspBootstrapState, deriveLspBootstrapSignal } from "../../src/agent/loop";

describe("lsp bootstrap state machine", () => {
  test("moves idle -> required on no_active_server", () => {
    const signal = deriveLspBootstrapSignal({
      artifacts: {
        lspStatus: "no_active_server",
      },
      output: "[lsp]\nstatus: no_active_server",
      success: true,
    });

    const transition = advanceLspBootstrapState({
      changedFiles: ["/repo/src/main.ts"],
      lspServerConfigPath: ".zace/runtime/lsp/servers.json",
      previousReason: null,
      previousState: "idle",
      signal,
      signalReason: "no_servers_configured",
    });

    expect(transition.state).toBe("required");
    expect(transition.reason).toBe("no_servers_configured");
    expect(transition.event).toBe("lsp_bootstrap_required");
  });

  test("moves required -> ready when diagnostics become active", () => {
    const signal = deriveLspBootstrapSignal({
      artifacts: {
        lspStatus: "no_errors",
      },
      output: "[lsp]\nstatus: no_errors",
      success: true,
    });

    const transition = advanceLspBootstrapState({
      changedFiles: ["/repo/src/main.ts"],
      lspServerConfigPath: ".zace/runtime/lsp/servers.json",
      previousReason: "no_servers_configured",
      previousState: "required",
      signal,
    });

    expect(transition.state).toBe("ready");
    expect(transition.reason).toBeNull();
    expect(transition.event).toBe("lsp_bootstrap_cleared");
  });

  test("keeps ready state on neutral no_applicable_files signal", () => {
    const signal = deriveLspBootstrapSignal({
      artifacts: {
        lspStatus: "no_applicable_files",
      },
      output: "[lsp]\nstatus: no_applicable_files",
      success: true,
    });

    const transition = advanceLspBootstrapState({
      changedFiles: [],
      lspServerConfigPath: ".zace/runtime/lsp/servers.json",
      previousReason: null,
      previousState: "ready",
      signal,
    });

    expect(transition.state).toBe("ready");
    expect(transition.reason).toBeNull();
    expect(transition.event).toBeUndefined();
  });
});
