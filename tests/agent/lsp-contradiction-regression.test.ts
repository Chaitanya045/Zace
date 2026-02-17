import { describe, expect, test } from "bun:test";

import { advanceLspBootstrapState, deriveLspBootstrapSignal } from "../../src/agent/loop";

describe("lsp contradiction regression", () => {
  test("does not downgrade ready bootstrap state on neutral follow-up statuses", () => {
    const requiredTransition = advanceLspBootstrapState({
      changedFiles: ["/repo/src/demo.ts"],
      lspServerConfigPath: ".zace/runtime/lsp/servers.json",
      previousReason: null,
      previousState: "idle",
      signal: deriveLspBootstrapSignal({
        artifacts: {
          lspStatus: "no_active_server",
        },
        output: "[lsp]\nstatus: no_active_server",
        success: true,
      }),
      signalReason: "no_servers_configured",
    });

    expect(requiredTransition.state).toBe("required");

    const clearedTransition = advanceLspBootstrapState({
      changedFiles: ["/repo/src/demo.ts"],
      lspServerConfigPath: ".zace/runtime/lsp/servers.json",
      previousReason: requiredTransition.reason,
      previousState: requiredTransition.state,
      signal: deriveLspBootstrapSignal({
        artifacts: {
          lspStatus: "no_errors",
        },
        output: "[lsp]\nstatus: no_errors",
        success: true,
      }),
    });

    expect(clearedTransition.state).toBe("ready");
    expect(clearedTransition.event).toBe("lsp_bootstrap_cleared");

    const neutralTransition = advanceLspBootstrapState({
      changedFiles: [],
      lspServerConfigPath: ".zace/runtime/lsp/servers.json",
      previousReason: clearedTransition.reason,
      previousState: clearedTransition.state,
      signal: deriveLspBootstrapSignal({
        artifacts: {
          lspStatus: "no_applicable_files",
        },
        output: "[lsp]\nstatus: no_applicable_files",
        success: true,
      }),
    });

    expect(neutralTransition.state).toBe("ready");
    expect(neutralTransition.event).toBeUndefined();
  });
});
