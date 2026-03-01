import { extname, isAbsolute, resolve } from "node:path";

import type { AgentConfig } from "../../types/config";
import type { ToolExecutionContext, ToolResult } from "../../types/tool";

import { probeFiles as probeLspFiles } from "../../lsp";
import {
  buildLspBootstrapRequirementMessage,
  type LspBootstrapState,
} from "./state-machine";

type CommandApprovalResult =
  | {
      commandSignature: string;
      message: string;
      reason: string;
      status: "request_user";
    }
  | {
      message: string;
      scope: "session" | "workspace";
      status: "deny";
    }
  | {
      requiredApproval: boolean;
      scope: "once" | "session" | "workspace";
      status: "allow";
    };

type LspAutoprovisionState = {
  attemptedCommands: string[];
  lastFailureReason: null | string;
  pendingChangedFiles: Set<string>;
  provisionAttempts: number;
  state: LspBootstrapState;
};

type ToolCallLike = {
  arguments: Record<string, unknown>;
  name: string;
};

export type LspAutoprovisionOutcome = {
  message: string;
  status: "failed" | "needs_user" | "resolved" | "skipped";
};

const EXTENSIONS_TS_JS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const EXTENSIONS_PY = new Set([".py"]);

const TEMPLATE_SERVER_IDS = {
  python: "python",
  typescript: "typescript",
} as const;

function toAbsoluteConfigPath(configPath: string, workingDirectory: string): string {
  return isAbsolute(configPath) ? resolve(configPath) : resolve(workingDirectory, configPath);
}

function buildBunEvalCommand(source: string): string {
  const sourceBase64 = Buffer.from(source, "utf8").toString("base64");
  // Load via temp file to avoid very long data: URLs (NameTooLong) and avoid
  // eval parsing issues with ESM `import` in the decoded source.
  const loader = [
    "import { rmSync, writeFileSync } from \"node:fs\";",
    "import { join } from \"node:path\";",
    "import { pathToFileURL } from \"node:url\";",
    "const source = Buffer.from(process.argv[1], \"base64\").toString(\"utf8\");",
    "const tmpPath = join(process.cwd(), \".zace-autoprovision-\" + String(Date.now()) + \".mjs\");",
    "writeFileSync(tmpPath, source, \"utf8\");",
    "try { await import(pathToFileURL(tmpPath).href); } finally { rmSync(tmpPath, { force: true }); }",
  ].join("\n");
  return `bun -e '${loader}' '${sourceBase64}'`;
}

function buildAutoprovisionCommand(configPath: string, template: unknown): string {
  const source = `
 import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { dirname } from "node:path";

const configPath = ${JSON.stringify(configPath)};
 const markerWritten = "ZACE_LSP_AUTOPROVISION_WRITTEN|" + configPath;
 const markerSkipped = "ZACE_LSP_AUTOPROVISION_SKIP|existing_servers";

let hasExistingServers = false;
try {
  const raw = readFileSync(configPath, "utf8").trim();
  if (raw.length > 0) {
    const parsed = JSON.parse(raw);
    const servers = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray(parsed.servers)
        ? parsed.servers
        : [];
    hasExistingServers = Array.isArray(servers) && servers.length > 0;
  }
} catch (_error) {
  hasExistingServers = false;
}

if (hasExistingServers) {
  console.log(markerSkipped);
} else {
  mkdirSync(dirname(configPath), { recursive: true });
   const payload = ${JSON.stringify(JSON.stringify(template, null, 2) + "\n")};
   writeFileSync(configPath, payload, "utf8");
   console.log("ZACE_FILE_CHANGED|" + configPath);
   console.log(markerWritten);
 }
  `.trim();

  return buildBunEvalCommand(source);
}

function pendingFilesSupportProvisioning(pendingFiles: string[]): boolean {
  return pendingFiles.some((filePath) => {
    const extension = extname(filePath).toLowerCase();
    return EXTENSIONS_TS_JS.has(extension) || EXTENSIONS_PY.has(extension);
  });
}

function buildTemplateForPendingFiles(pendingFiles: string[]): {
  servers: Array<{
    command: string[];
    extensions: string[];
    id: string;
    rootMarkers: string[];
  }>;
  templateIds: string[];
} {
  const extensions = new Set(pendingFiles.map((filePath) => extname(filePath).toLowerCase()));
  const servers: Array<{
    command: string[];
    extensions: string[];
    id: string;
    rootMarkers: string[];
  }> = [];
  const templateIds: string[] = [];

  if (Array.from(extensions).some((ext) => EXTENSIONS_TS_JS.has(ext))) {
    servers.push({
      command: ["bunx", "typescript-language-server", "--stdio"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      id: TEMPLATE_SERVER_IDS.typescript,
      rootMarkers: ["tsconfig.json", "package.json"],
    });
    templateIds.push(TEMPLATE_SERVER_IDS.typescript);
  }

  if (extensions.has(".py")) {
    servers.push({
      command: ["bunx", "pyright-langserver", "--stdio"],
      extensions: [".py"],
      id: TEMPLATE_SERVER_IDS.python,
      rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py"],
    });
    templateIds.push(TEMPLATE_SERVER_IDS.python);
  }

  return {
    servers,
    templateIds,
  };
}

function pushAttemptedCommand(state: LspAutoprovisionState, command: string): void {
  const compact = command.replace(/\s+/gu, " ").trim();
  const preview = compact.length > 220 ? `${compact.slice(0, 220)}...` : compact;
  state.attemptedCommands.push(preview);
  if (state.attemptedCommands.length > 5) {
    state.attemptedCommands.shift();
  }
}

export async function attemptRuntimeLspAutoprovision(input: {
  appendRunEvent: (input: {
    event: string;
    payload?: Record<string, unknown>;
    phase: "approval" | "executing" | "finalizing" | "planning";
    step: number;
  }) => Promise<void>;
  config: AgentConfig;
  lspBootstrap: LspAutoprovisionState;
  resolveCommandApproval: (input: {
    command: string;
    workingDirectory?: string;
  }) => Promise<CommandApprovalResult>;
  runToolCall: (toolCall: ToolCallLike, context?: ToolExecutionContext) => Promise<ToolResult>;
  stepNumber: number;
  toolExecutionContext?: ToolExecutionContext;
  workingDirectory: string;
}): Promise<LspAutoprovisionOutcome> {
  const pendingFiles = Array.from(input.lspBootstrap.pendingChangedFiles).sort((left, right) =>
    left.localeCompare(right)
  );
  if (pendingFiles.length === 0) {
    const message =
      "LSP auto-provision skipped: no pending changed files were tracked for bootstrap.";
    await input.appendRunEvent({
      event: "lsp_autoprovision_skipped",
      payload: {
        reason: "no_pending_files",
      },
      phase: "executing",
      step: input.stepNumber,
    });
    return {
      message,
      status: "skipped",
    };
  }

  if (!pendingFilesSupportProvisioning(pendingFiles)) {
    const message =
      "LSP auto-provision skipped: pending files are not applicable to the built-in TypeScript/JavaScript/Python templates.";
    await input.appendRunEvent({
      event: "lsp_autoprovision_skipped",
      payload: {
        pendingFiles: pendingFiles.slice(0, 20),
        reason: "no_supported_extensions",
      },
      phase: "executing",
      step: input.stepNumber,
    });
    return {
      message,
      status: "skipped",
    };
  }

  const absoluteConfigPath = toAbsoluteConfigPath(
    input.config.lspServerConfigPath,
    input.workingDirectory
  );

  const template = buildTemplateForPendingFiles(pendingFiles);
  if (template.servers.length === 0) {
    const message =
      "LSP auto-provision skipped: no supported language servers matched pending changed files.";
    await input.appendRunEvent({
      event: "lsp_autoprovision_skipped",
      payload: {
        pendingFiles: pendingFiles.slice(0, 20),
        reason: "no_supported_templates",
      },
      phase: "executing",
      step: input.stepNumber,
    });
    return {
      message,
      status: "skipped",
    };
  }

  const provisionCommand = buildAutoprovisionCommand(absoluteConfigPath, { servers: template.servers });
  pushAttemptedCommand(input.lspBootstrap, provisionCommand);

  const approval = await input.resolveCommandApproval({
    command: provisionCommand,
    workingDirectory: input.workingDirectory,
  });
  if (approval.status === "deny") {
    input.lspBootstrap.provisionAttempts += 1;
    const message = `LSP auto-provision blocked by approval policy: ${approval.message}`;
    input.lspBootstrap.lastFailureReason = "approval_denied";
    input.lspBootstrap.state = "failed";
    await input.appendRunEvent({
      event: "lsp_autoprovision_failed",
      payload: {
        configPath: absoluteConfigPath,
        reason: "approval_denied",
      },
      phase: "approval",
      step: input.stepNumber,
    });
    return {
      message,
      status: "failed",
    };
  }
  if (approval.status === "request_user") {
    await input.appendRunEvent({
      event: "approval_requested",
      payload: {
        command: provisionCommand,
        commandSignature: approval.commandSignature,
        reason: approval.reason,
        source: "lsp_autoprovision",
      },
      phase: "approval",
      step: input.stepNumber,
    });
    return {
      message: approval.message,
      status: "needs_user",
    };
  }

  await input.appendRunEvent({
    event: "lsp_autoprovision_started",
    payload: {
      configPath: absoluteConfigPath,
      pendingFiles: pendingFiles.slice(0, 20),
      templates: template.templateIds,
    },
    phase: "executing",
    step: input.stepNumber,
  });

  const provisionResult = await input.runToolCall({
    arguments: {
      command: provisionCommand,
      cwd: input.workingDirectory,
      timeout: 30_000,
    },
    name: "execute_command",
  }, input.toolExecutionContext);

  await input.appendRunEvent({
    event: "lsp_autoprovision_command_finished",
    payload: {
      configPath: absoluteConfigPath,
      success: provisionResult.success,
    },
    phase: "executing",
    step: input.stepNumber,
  });

  if (!provisionResult.success) {
    input.lspBootstrap.provisionAttempts += 1;
    const reason = provisionResult.error ?? "lsp_autoprovision_command_failed";
    input.lspBootstrap.lastFailureReason = reason;
    input.lspBootstrap.state = "failed";
    await input.appendRunEvent({
      event: "lsp_autoprovision_failed",
      payload: {
        commandOutput: provisionResult.output,
        configPath: absoluteConfigPath,
        reason,
      },
      phase: "executing",
      step: input.stepNumber,
    });
    const message =
      `LSP auto-provision failed: ${reason}. ` +
      `Fix ${input.config.lspServerConfigPath} manually or adjust server command availability.`;
    return {
      message,
      status: "failed",
    };
  }

  const commandOutput = provisionResult.output;
  const wroteConfig = commandOutput.includes("ZACE_LSP_AUTOPROVISION_WRITTEN|");
  const eventName = wroteConfig ? "lsp_autoprovision_written" : "lsp_autoprovision_skipped";
  await input.appendRunEvent({
    event: eventName,
    payload: {
      configPath: absoluteConfigPath,
      reason: wroteConfig ? "template_written" : "existing_servers_preserved",
    },
    phase: "executing",
    step: input.stepNumber,
  });

  await input.appendRunEvent({
    event: "lsp_bootstrap_probe_started",
    payload: {
      files: pendingFiles.slice(0, 20),
      lspServerConfigPath: input.config.lspServerConfigPath,
      source: "runtime_autoprovision",
    },
    phase: "executing",
    step: input.stepNumber,
  });
  const probeResult = await probeLspFiles(pendingFiles);

  if (probeResult.status === "active") {
    input.lspBootstrap.state = "ready";
    input.lspBootstrap.lastFailureReason = null;
    input.lspBootstrap.pendingChangedFiles.clear();
    await input.appendRunEvent({
      event: "lsp_bootstrap_probe_succeeded",
      payload: {
        diagnosticFiles: probeResult.diagnosticsFiles.slice(0, 20),
        source: "runtime_autoprovision",
      },
      phase: "executing",
      step: input.stepNumber,
    });
    return {
      message: "LSP auto-provision succeeded and diagnostics probe is active for changed files.",
      status: "resolved",
    };
  }

  input.lspBootstrap.provisionAttempts += 1;
  const reason = probeResult.reason ?? "LSP bootstrap probe did not activate diagnostics";
  input.lspBootstrap.state = probeResult.status === "failed" ? "failed" : "required";
  input.lspBootstrap.lastFailureReason = reason;

  await input.appendRunEvent({
    event: "lsp_bootstrap_probe_failed",
    payload: {
      reason,
      source: "runtime_autoprovision",
      state: input.lspBootstrap.state,
    },
    phase: "executing",
    step: input.stepNumber,
  });

  const requirementMessage = buildLspBootstrapRequirementMessage(
    input.config.lspServerConfigPath,
    pendingFiles,
    reason
  );
  return {
    message: `LSP auto-provision ran but bootstrap is still unresolved. ${requirementMessage}`,
    status: "failed",
  };
}
