import { extname, resolve } from "node:path";

import type { AgentConfig } from "../../../types/config";
import type { ToolResult } from "../../../types/tool";
import type { AgentObserver } from "../../observer";
import type { LspBootstrapContext } from "./types";

import { probeFiles as probeLspFiles } from "../../../lsp";
import {
  advanceLspBootstrapState,
  buildLspBootstrapRequirementMessage,
  deriveLspBootstrapSignal,
  shouldTrackPendingLspFiles,
} from "../../lsp-bootstrap/state-machine";
import { appendRunEvent } from "./run-events";

const NON_DIAGNOSTIC_SOURCE_EXTENSIONS = new Set([
  ".bmp",
  ".conf",
  ".css",
  ".csv",
  ".env",
  ".gif",
  ".html",
  ".ini",
  ".jpeg",
  ".jpg",
  ".json",
  ".jsonl",
  ".lock",
  ".log",
  ".md",
  ".png",
  ".svg",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function isTrackableLspPendingFile(filePath: string): boolean {
  const normalized = resolve(filePath).replaceAll("\\", "/");
  if (normalized.includes("/.zace/runtime/")) {
    return false;
  }

  const extension = extname(normalized).toLowerCase();
  if (!extension) {
    return false;
  }

  return !NON_DIAGNOSTIC_SOURCE_EXTENSIONS.has(extension);
}

export async function handleLspBootstrapAfterToolExecution(input: {
  changedFiles: string[];
  config: AgentConfig;
  lspBootstrap: LspBootstrapContext;
  lspServerConfigAbsolutePath: string;
  memory: {
    addMessage: (role: "assistant", content: string) => void;
  };
  observer?: AgentObserver;
  plannedExecuteCommand?: string;
  runId: string;
  sessionId?: string;
  stepNumber: number;
  toolResult: ToolResult;
}): Promise<void> {
  const lspStatus = input.toolResult.artifacts?.lspStatus;
  if (lspStatus) {
    await appendRunEvent({
      event: "lsp_status_observed",
      observer: input.observer,
      payload: {
        reason: input.toolResult.artifacts?.lspStatusReason,
        status: lspStatus,
      },
      phase: "executing",
      runId: input.runId,
      sessionId: input.sessionId,
      step: input.stepNumber,
    });
  }
  const lspBootstrapSignal = deriveLspBootstrapSignal(input.toolResult);
  const lspStatusReason = input.toolResult.artifacts?.lspStatusReason;
  const nonConfigChangedFiles = input.changedFiles
    .map((filePath) => resolve(filePath))
    .filter((filePath) => filePath !== input.lspServerConfigAbsolutePath)
    .filter((filePath) => isTrackableLspPendingFile(filePath));
  if (shouldTrackPendingLspFiles(lspBootstrapSignal)) {
    for (const filePath of nonConfigChangedFiles) {
      input.lspBootstrap.pendingChangedFiles.add(filePath);
    }
  }
  const transition = advanceLspBootstrapState({
    changedFiles: Array.from(input.lspBootstrap.pendingChangedFiles),
    lspServerConfigPath: input.config.lspServerConfigPath,
    previousReason: input.lspBootstrap.lastFailureReason,
    previousState: input.lspBootstrap.state,
    signal: lspBootstrapSignal,
    signalReason: lspStatusReason,
  });
  input.lspBootstrap.state = transition.state;
  input.lspBootstrap.lastFailureReason = transition.reason;
  if (lspBootstrapSignal === "active") {
    input.lspBootstrap.pendingChangedFiles.clear();
  }
  if (transition.event && transition.message) {
    input.memory.addMessage("assistant", transition.message);
    await appendRunEvent({
      event: transition.event,
      observer: input.observer,
      payload: transition.payload ?? {},
      phase: "executing",
      runId: input.runId,
      sessionId: input.sessionId,
      step: input.stepNumber,
    });
  }

  const touchedLspConfig =
    input.changedFiles.some((filePath) => resolve(filePath) === input.lspServerConfigAbsolutePath) ||
    (input.plannedExecuteCommand?.includes(input.config.lspServerConfigPath) ?? false);
  if (
    touchedLspConfig &&
    input.lspBootstrap.pendingChangedFiles.size > 0 &&
    (input.lspBootstrap.state === "required" || input.lspBootstrap.state === "failed")
  ) {
    input.lspBootstrap.state = "probing";
    await appendRunEvent({
      event: "lsp_bootstrap_probe_started",
      observer: input.observer,
      payload: {
        files: Array.from(input.lspBootstrap.pendingChangedFiles).slice(0, 20),
        lspServerConfigPath: input.config.lspServerConfigPath,
      },
      phase: "executing",
      runId: input.runId,
      sessionId: input.sessionId,
      step: input.stepNumber,
    });

    const probeResult = await probeLspFiles(Array.from(input.lspBootstrap.pendingChangedFiles));
    if (probeResult.status === "active") {
      input.lspBootstrap.state = "ready";
      input.lspBootstrap.lastFailureReason = null;
      input.lspBootstrap.pendingChangedFiles.clear();
      await appendRunEvent({
        event: "lsp_bootstrap_probe_succeeded",
        observer: input.observer,
        payload: {
          diagnosticFiles: probeResult.diagnosticsFiles.slice(0, 20),
        },
        phase: "executing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
      input.memory.addMessage(
        "assistant",
        "LSP bootstrap probe succeeded after servers config update."
      );
    } else {
      const reason = probeResult.reason ?? "LSP bootstrap probe did not activate diagnostics";
      input.lspBootstrap.state = probeResult.status === "failed" ? "failed" : "required";
      input.lspBootstrap.lastFailureReason = reason;
      input.lspBootstrap.provisionAttempts += 1;
      if (input.plannedExecuteCommand) {
        const compactCommand = input.plannedExecuteCommand.replace(/\s+/gu, " ").trim();
        const preview = compactCommand.length > 220
          ? `${compactCommand.slice(0, 220)}...`
          : compactCommand;
        input.lspBootstrap.attemptedCommands.push(preview);
        if (input.lspBootstrap.attemptedCommands.length > 5) {
          input.lspBootstrap.attemptedCommands.shift();
        }
      }
      await appendRunEvent({
        event: "lsp_bootstrap_probe_failed",
        observer: input.observer,
        payload: {
          reason,
          state: input.lspBootstrap.state,
        },
        phase: "executing",
        runId: input.runId,
        sessionId: input.sessionId,
        step: input.stepNumber,
      });
      input.memory.addMessage(
        "assistant",
        buildLspBootstrapRequirementMessage(
          input.config.lspServerConfigPath,
          Array.from(input.lspBootstrap.pendingChangedFiles),
          reason
        )
      );
    }
  }
}
