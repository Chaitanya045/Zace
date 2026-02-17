import { extname, isAbsolute, resolve } from "node:path";

import { env } from "../config/env";
import { log } from "../utils/logger";
import { LspClient, type LspDiagnostic, type LspRange } from "./client";
import {
  loadLspServersConfig,
  resolveServerRootPath,
  type LspServerConfig,
} from "./config";

type LspState = {
  brokenKeys: Set<string>;
  clients: Map<string, LspClient>;
  configFilePath?: string;
  configFileMtimeMs?: number;
  servers: LspServerConfig[];
  spawning: Map<string, Promise<LspClient | undefined>>;
};

type LspStatus = {
  id: string;
  root: string;
  status: "connected" | "error";
};

const state: LspState = {
  brokenKeys: new Set(),
  clients: new Map(),
  servers: [],
  spawning: new Map(),
};

function normalizeAbsolutePath(pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return resolve(pathValue);
  }

  return resolve(process.cwd(), pathValue);
}

function buildClientKey(rootPath: string, serverId: string): string {
  return `${rootPath}::${serverId}`;
}

async function refreshServerConfig(): Promise<void> {
  const loaded = await loadLspServersConfig(env.AGENT_LSP_SERVER_CONFIG_PATH);
  const configChanged =
    state.configFilePath !== loaded.filePath ||
    state.configFileMtimeMs !== loaded.mtimeMs;

  if (!configChanged) {
    return;
  }

  const previousServerIds = new Set(state.servers.map((server) => server.id));
  const nextServerIds = new Set(loaded.servers.map((server) => server.id));

  for (const [key, client] of state.clients.entries()) {
    const serverId = key.split("::").at(-1) ?? "";
    if (!nextServerIds.has(serverId)) {
      client.shutdown();
      state.clients.delete(key);
      state.brokenKeys.delete(key);
    }
  }

  state.configFilePath = loaded.filePath;
  state.configFileMtimeMs = loaded.mtimeMs;
  state.servers = loaded.servers;

  if (loaded.servers.length === 0) {
    log(`LSP config loaded from ${loaded.filePath} with 0 servers`);
    return;
  }

  if (previousServerIds.size !== nextServerIds.size) {
    log(`LSP config refreshed from ${loaded.filePath} with ${String(loaded.servers.length)} servers`);
  }
}

function serverSupportsFile(server: LspServerConfig, filePath: string): boolean {
  if (server.extensions.length === 0) {
    return true;
  }

  const extension = extname(filePath);
  return server.extensions.includes(extension);
}

async function createOrGetClient(server: LspServerConfig, filePath: string): Promise<LspClient | undefined> {
  const rootPath = await resolveServerRootPath(filePath, server);
  const key = buildClientKey(rootPath, server.id);

  if (state.brokenKeys.has(key)) {
    return undefined;
  }

  const existing = state.clients.get(key);
  if (existing) {
    return existing;
  }

  const inflight = state.spawning.get(key);
  if (inflight) {
    return inflight;
  }

  const task = LspClient.create({
    rootPath,
    server,
    waitForDiagnosticsMs: env.AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS,
  })
    .then((client) => {
      state.clients.set(key, client);
      return client;
    })
    .catch((error) => {
      state.brokenKeys.add(key);
      log(
        `Failed to initialize LSP client ${server.id}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      return undefined;
    })
    .finally(() => {
      if (state.spawning.get(key) === task) {
        state.spawning.delete(key);
      }
    });

  state.spawning.set(key, task);
  return task;
}

async function resolveClientsForFile(filePath: string): Promise<LspClient[]> {
  await refreshServerConfig();
  if (state.servers.length === 0) {
    return [];
  }

  const absolutePath = normalizeAbsolutePath(filePath);
  const resolvedClients = await Promise.all(
    state.servers
      .filter((server) => serverSupportsFile(server, absolutePath))
      .map((server) => createOrGetClient(server, absolutePath))
  );

  return resolvedClients.filter((client): client is LspClient => Boolean(client));
}

export async function init(): Promise<void> {
  await refreshServerConfig();
}

export async function shutdown(): Promise<void> {
  for (const client of state.clients.values()) {
    client.shutdown();
  }
  state.clients.clear();
  state.brokenKeys.clear();
  state.servers = [];
  state.spawning.clear();
}

export const initLsp = init;
export const shutdownLsp = shutdown;

export async function touchFile(filePath: string, waitForDiagnostics: boolean = false): Promise<void> {
  const absolutePath = normalizeAbsolutePath(filePath);
  const clients = await resolveClientsForFile(absolutePath);
  if (clients.length === 0) {
    return;
  }

  await Promise.all(
    clients.map(async (client) => {
      const waitTask = waitForDiagnostics ? client.waitForDiagnostics(absolutePath) : Promise.resolve();
      await client.notifyOpen(absolutePath);
      await waitTask;
    })
  );
}

export async function touchFiles(filePaths: string[], waitForDiagnostics: boolean = false): Promise<void> {
  if (filePaths.length === 0) {
    return;
  }

  const normalized = Array.from(
    new Set(filePaths.map((filePath) => normalizeAbsolutePath(filePath)))
  );

  for (const filePath of normalized) {
    await touchFile(filePath, waitForDiagnostics);
  }
}

export async function diagnostics(): Promise<Record<string, LspDiagnostic[]>> {
  const aggregated: Record<string, LspDiagnostic[]> = {};
  for (const client of state.clients.values()) {
    for (const [pathValue, fileDiagnostics] of client.diagnostics.entries()) {
      const existing = aggregated[pathValue] ?? [];
      aggregated[pathValue] = [...existing, ...fileDiagnostics];
    }
  }
  return aggregated;
}

export async function status(): Promise<LspStatus[]> {
  const statuses: LspStatus[] = [];
  for (const client of state.clients.values()) {
    const snapshot = client.status;
    statuses.push({
      id: snapshot.serverId,
      root: snapshot.rootPath,
      status: snapshot.status,
    });
  }
  return statuses;
}

function formatRangeStart(range: LspRange): string {
  const line = range.start.line + 1;
  const character = range.start.character + 1;
  return `${String(line)}:${String(character)}`;
}

export function formatDiagnostic(diagnostic: LspDiagnostic): string {
  const severityLabel = diagnostic.severity === 1
    ? "ERROR"
    : diagnostic.severity === 2
      ? "WARN"
      : diagnostic.severity === 3
        ? "INFO"
        : "HINT";

  return `${severityLabel} [${formatRangeStart(diagnostic.range)}] ${diagnostic.message}`;
}
