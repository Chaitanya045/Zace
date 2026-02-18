import type { ToolResult } from "../../types/tool";

const LSP_BOOTSTRAP_FILE_PREVIEW_LIMIT = 5;

export type LspBootstrapSignal = "active" | "failed" | "none" | "required";

export type LspBootstrapState = "failed" | "idle" | "probing" | "ready" | "required";

export type LspBootstrapTransition = {
  event?: "lsp_bootstrap_cleared" | "lsp_bootstrap_required";
  message?: string;
  payload?: Record<string, unknown>;
  reason: null | string;
  state: LspBootstrapState;
};

export function deriveLspBootstrapSignal(toolResult: ToolResult): LspBootstrapSignal {
  const status = toolResult.artifacts?.lspStatus;
  if (status === "no_active_server") {
    return "required";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "diagnostics" || status === "no_errors") {
    return "active";
  }
  return "none";
}

export function shouldTrackPendingLspFiles(signal: LspBootstrapSignal): boolean {
  return signal === "active" || signal === "failed" || signal === "required";
}

export function buildLspBootstrapRequirementMessage(
  lspServerConfigPath: string,
  changedFiles: string[],
  reason?: string
): string {
  const normalizedFiles = Array.from(new Set(changedFiles.map((value) => value.trim()).filter(Boolean)));
  const preview = normalizedFiles.slice(0, LSP_BOOTSTRAP_FILE_PREVIEW_LIMIT);
  const filesText = preview.length > 0
    ? `\nChanged files (sample): ${preview.join(", ")}${normalizedFiles.length > preview.length ? ", ..." : ""}`
    : "";
  const reasonText = reason ? `\nReason: ${reason}` : "";
  return (
    `LSP bootstrap required: no active LSP server is configured for changed files.\n` +
    `Create or update ${lspServerConfigPath} for this repository and rerun validation commands before completing.` +
    reasonText +
    filesText
  );
}

export function advanceLspBootstrapState(input: {
  changedFiles: string[];
  lspServerConfigPath: string;
  previousReason: null | string;
  previousState: LspBootstrapState;
  signal: LspBootstrapSignal;
  signalReason?: string;
}): LspBootstrapTransition {
  if (input.signal === "none") {
    return {
      reason: input.previousReason,
      state: input.previousState,
    };
  }

  if (input.signal === "active") {
    const nextState: LspBootstrapState = "ready";
    const nextReason: null = null;
    const shouldEmit =
      input.previousState !== "idle" &&
      (input.previousState !== nextState || input.previousReason !== nextReason);
    if (!shouldEmit) {
      return {
        reason: nextReason,
        state: nextState,
      };
    }

    return {
      event: "lsp_bootstrap_cleared",
      message: "LSP diagnostics are active for changed files; LSP bootstrap requirement is cleared.",
      payload: {
        lspServerConfigPath: input.lspServerConfigPath,
      },
      reason: nextReason,
      state: nextState,
    };
  }

  const nextState: LspBootstrapState = input.signal === "failed" ? "failed" : "required";
  const normalizedReason = input.signalReason?.trim();
  const nextReason = normalizedReason && normalizedReason.length > 0
    ? normalizedReason
    : input.previousReason;

  if (input.previousState === nextState && input.previousReason === nextReason) {
    return {
      reason: nextReason,
      state: nextState,
    };
  }

  return {
    event: "lsp_bootstrap_required",
    message: buildLspBootstrapRequirementMessage(
      input.lspServerConfigPath,
      input.changedFiles,
      nextReason ?? undefined
    ),
    payload: {
      changedFiles: input.changedFiles.slice(0, 20),
      lspFailureReason: nextReason,
      lspServerConfigPath: input.lspServerConfigPath,
      lspStatus: nextState === "failed" ? "failed" : "no_active_server",
    },
    reason: nextReason,
    state: nextState,
  };
}

export function shouldBlockForBootstrap(input: {
  completionRequireLsp?: boolean;
  lspBootstrapBlockOnFailed: boolean;
  lspEnabled: boolean;
  lspState: LspBootstrapState;
}): boolean {
  const completionRequireLsp = input.completionRequireLsp ?? true;
  if (!completionRequireLsp) {
    return false;
  }

  if (!input.lspEnabled) {
    return false;
  }

  if (input.lspState === "required") {
    return true;
  }

  return input.lspBootstrapBlockOnFailed && input.lspState === "failed";
}
