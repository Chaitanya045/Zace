import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

import type { LspServerConfig } from "./config";

export interface LspPosition {
  character: number;
  line: number;
}

export interface LspRange {
  end: LspPosition;
  start: LspPosition;
}

export interface LspDiagnostic {
  code?: number | string;
  message: string;
  range: LspRange;
  severity?: number;
  source?: string;
}

export interface LspClientCreateInput {
  rootPath: string;
  server: LspServerConfig;
  waitForDiagnosticsMs: number;
}

export interface LspClientStatus {
  rootPath: string;
  serverId: string;
  status: "connected" | "error";
}

type DiagnosticsWaiter = {
  baselineVersion: number;
  settle: () => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

const DIAGNOSTICS_DEBOUNCE_MS = 150;
const INITIALIZE_TIMEOUT_MS = 15_000;

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutTask]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function resolveLanguageId(filePath: string): string {
  const extension = extname(filePath).trim();
  if (!extension) {
    return "plaintext";
  }

  const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
  return normalized || "plaintext";
}

function normalizeAbsolutePath(pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return resolve(pathValue);
  }

  return resolve(process.cwd(), pathValue);
}

export class LspClient {
  private readonly diagnosticsByFile = new Map<string, LspDiagnostic[]>();

  private readonly diagnosticsVersionByFile = new Map<string, number>();

  private readonly openedFileVersions = new Map<string, number>();

  private readonly pendingDiagnosticWaiters = new Map<string, DiagnosticsWaiter[]>();

  private readonly diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly processHandle: ChildProcessWithoutNullStreams;

  private readonly rootPath: string;

  private readonly server: LspServerConfig;

  private readonly waitForDiagnosticsMs: number;

  private readonly connection: ReturnType<typeof createMessageConnection>;

  private statusValue: "connected" | "error" = "connected";

  private constructor(input: {
    connection: ReturnType<typeof createMessageConnection>;
    processHandle: ChildProcessWithoutNullStreams;
    rootPath: string;
    server: LspServerConfig;
    waitForDiagnosticsMs: number;
  }) {
    this.connection = input.connection;
    this.processHandle = input.processHandle;
    this.rootPath = input.rootPath;
    this.server = input.server;
    this.waitForDiagnosticsMs = input.waitForDiagnosticsMs;
  }

  static async create(input: LspClientCreateInput): Promise<LspClient> {
    const processHandle = spawn(input.server.command[0]!, input.server.command.slice(1), {
      cwd: input.rootPath,
      env: {
        ...process.env,
        ...input.server.env,
      },
      stdio: "pipe",
    });

    const connection = createMessageConnection(
      new StreamMessageReader(processHandle.stdout),
      new StreamMessageWriter(processHandle.stdin)
    );

    const client = new LspClient({
      connection,
      processHandle,
      rootPath: input.rootPath,
      server: input.server,
      waitForDiagnosticsMs: input.waitForDiagnosticsMs,
    });
    client.attachConnectionListeners();

    try {
      connection.listen();
      await withTimeout(
        connection.sendRequest("initialize", {
          capabilities: {
            textDocument: {
              publishDiagnostics: {
                versionSupport: true,
              },
              synchronization: {
                didChange: true,
                didOpen: true,
              },
            },
            workspace: {
              didChangeWatchedFiles: {
                dynamicRegistration: true,
              },
            },
          },
          initializationOptions: input.server.initialization ?? {},
          processId: processHandle.pid,
          rootUri: pathToFileURL(input.rootPath).href,
          workspaceFolders: [
            {
              name: "workspace",
              uri: pathToFileURL(input.rootPath).href,
            },
          ],
        }),
        INITIALIZE_TIMEOUT_MS,
        `LSP initialize timed out after ${String(INITIALIZE_TIMEOUT_MS)}ms`
      );
      await connection.sendNotification("initialized", {});
      if (input.server.initialization) {
        await connection.sendNotification("workspace/didChangeConfiguration", {
          settings: input.server.initialization,
        });
      }
      return client;
    } catch (error) {
      client.statusValue = "error";
      client.shutdown();
      throw error;
    }
  }

  get diagnostics(): Map<string, LspDiagnostic[]> {
    return this.diagnosticsByFile;
  }

  diagnosticsVersion(pathValue: string): number {
    const absolutePath = normalizeAbsolutePath(pathValue);
    return this.diagnosticsVersionByFile.get(absolutePath) ?? 0;
  }

  get status(): LspClientStatus {
    return {
      rootPath: this.rootPath,
      serverId: this.server.id,
      status: this.statusValue,
    };
  }

  async notifyOpen(pathValue: string): Promise<void> {
    const absolutePath = normalizeAbsolutePath(pathValue);
    const uri = pathToFileURL(absolutePath).href;
    const text = await readFile(absolutePath, "utf8");
    const nextVersion = (this.openedFileVersions.get(absolutePath) ?? 0) + 1;
    this.openedFileVersions.set(absolutePath, nextVersion);

    if (nextVersion === 1) {
      this.diagnosticsByFile.delete(absolutePath);
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          languageId: resolveLanguageId(absolutePath),
          text,
          uri,
          version: nextVersion,
        },
      });
      return;
    }

    await this.connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [
        {
          type: 2,
          uri,
        },
      ],
    });
    await this.connection.sendNotification("textDocument/didChange", {
      contentChanges: [
        {
          text,
        },
      ],
      textDocument: {
        uri,
        version: nextVersion,
      },
    });
  }

  async waitForDiagnostics(pathValue: string, baselineVersion: number = 0): Promise<void> {
    const absolutePath = normalizeAbsolutePath(pathValue);
    const currentVersion = this.diagnosticsVersionByFile.get(absolutePath) ?? 0;
    if (currentVersion > baselineVersion) {
      return;
    }

    await new Promise<void>((resolveWait) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        const remaining = (this.pendingDiagnosticWaiters.get(absolutePath) ?? []).filter(
          (waiter) => waiter.settle !== settle
        );
        if (remaining.length === 0) {
          this.pendingDiagnosticWaiters.delete(absolutePath);
        } else {
          this.pendingDiagnosticWaiters.set(absolutePath, remaining);
        }
        resolveWait();
      };

      timeoutHandle = setTimeout(() => {
        settle();
      }, this.waitForDiagnosticsMs);
      const waiters = this.pendingDiagnosticWaiters.get(absolutePath) ?? [];
      waiters.push({
        baselineVersion,
        settle,
        timeoutHandle,
      });
      this.pendingDiagnosticWaiters.set(absolutePath, waiters);
    });
  }

  shutdown(): void {
    this.statusValue = "error";
    this.connection.end();
    this.connection.dispose();
    this.processHandle.kill();
    for (const timer of this.diagnosticDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.diagnosticDebounceTimers.clear();
    this.clearAndResolveAllWaiters();
  }

  private attachConnectionListeners(): void {
    this.connection.onNotification("textDocument/publishDiagnostics", (payload: unknown) => {
      const parsedPayload = payload as {
        diagnostics?: LspDiagnostic[];
        uri?: string;
      };

      const uri = parsedPayload.uri;
      if (!uri) {
        return;
      }

      const filePath = normalizeAbsolutePath(fileURLToPath(uri));
      this.diagnosticsByFile.set(filePath, parsedPayload.diagnostics ?? []);
      const nextVersion = (this.diagnosticsVersionByFile.get(filePath) ?? 0) + 1;
      this.diagnosticsVersionByFile.set(filePath, nextVersion);
      const pendingTimer = this.diagnosticDebounceTimers.get(filePath);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
      }
      const timer = setTimeout(() => {
        this.diagnosticDebounceTimers.delete(filePath);
        this.resolveReadyDiagnosticWaiters(filePath);
      }, DIAGNOSTICS_DEBOUNCE_MS);
      this.diagnosticDebounceTimers.set(filePath, timer);
    });

    this.connection.onRequest("window/workDoneProgress/create", async () => null);
    this.connection.onRequest("workspace/configuration", async () => [this.server.initialization ?? {}]);
    this.connection.onRequest("client/registerCapability", async () => null);
    this.connection.onRequest("client/unregisterCapability", async () => null);
    this.connection.onRequest("workspace/workspaceFolders", async () => [
      {
        name: "workspace",
        uri: pathToFileURL(this.rootPath).href,
      },
    ]);

    this.processHandle.on("exit", () => {
      this.statusValue = "error";
      for (const timer of this.diagnosticDebounceTimers.values()) {
        clearTimeout(timer);
      }
      this.diagnosticDebounceTimers.clear();
      this.clearAndResolveAllWaiters();
    });
  }

  private clearAndResolveAllWaiters(): void {
    for (const waiters of this.pendingDiagnosticWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutHandle);
        waiter.settle();
      }
    }
    this.pendingDiagnosticWaiters.clear();
  }

  private resolveReadyDiagnosticWaiters(filePath: string): void {
    const waiters = this.pendingDiagnosticWaiters.get(filePath) ?? [];
    if (waiters.length === 0) {
      return;
    }

    const currentVersion = this.diagnosticsVersionByFile.get(filePath) ?? 0;
    for (const waiter of waiters) {
      if (currentVersion > waiter.baselineVersion) {
        clearTimeout(waiter.timeoutHandle);
        waiter.settle();
      }
    }
  }
}
