import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

export const lspServerConfigSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  env: z.record(z.string(), z.string()).optional(),
  extensions: z.array(z.string().min(1)).default([]),
  id: z.string().min(1),
  initialization: z.record(z.string(), z.unknown()).optional(),
  rootMarkers: z.array(z.string().min(1)).default([]),
}).strict();

export const lspServersFileSchema = z.union([
  z.array(lspServerConfigSchema),
  z.object({
    servers: z.array(lspServerConfigSchema),
  }).strict(),
]);

export type LspServerConfig = z.infer<typeof lspServerConfigSchema>;

export type LspServersConfigLoadResult = {
  filePath: string;
  mtimeMs?: number;
  servers: LspServerConfig[];
};

function normalizeServerConfigPath(configPath: string): string {
  if (isAbsolute(configPath)) {
    return resolve(configPath);
  }

  return resolve(process.cwd(), configPath);
}

function toServerList(parsed: z.infer<typeof lspServersFileSchema>): LspServerConfig[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  return parsed.servers;
}

async function loadServerConfigFile(filePath: string): Promise<LspServerConfig[]> {
  const raw = await readFile(filePath, "utf8");
  const parsedJson = JSON.parse(raw) as unknown;
  const parsed = lspServersFileSchema.parse(parsedJson);
  return toServerList(parsed);
}

async function resolveRootWithMarkers(filePath: string, markers: string[]): Promise<string> {
  if (markers.length === 0) {
    return process.cwd();
  }

  const startDirectory = resolve(dirname(filePath));
  const stopDirectory = resolve(process.cwd());
  const stopAtCwd =
    startDirectory === stopDirectory || startDirectory.startsWith(stopDirectory + sep);
  let currentDirectory = startDirectory;

  while (true) {
    for (const marker of markers) {
      const markerPath = join(currentDirectory, marker);
      const markerExists = await stat(markerPath)
        .then(() => true)
        .catch(() => false);
      if (markerExists) {
        return currentDirectory;
      }
    }

    if (stopAtCwd && currentDirectory === stopDirectory) {
      return stopDirectory;
    }

    const parent = dirname(currentDirectory);
    if (parent === currentDirectory) {
      return stopAtCwd ? stopDirectory : startDirectory;
    }
    currentDirectory = parent;
  }
}

export async function resolveServerRootPath(
  filePath: string,
  server: Pick<LspServerConfig, "rootMarkers">
): Promise<string> {
  return resolveRootWithMarkers(filePath, server.rootMarkers);
}

export async function loadLspServersConfig(
  configPath: string
): Promise<LspServersConfigLoadResult> {
  const filePath = normalizeServerConfigPath(configPath);

  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      return {
        filePath,
        servers: [],
      };
    }

    const servers = await loadServerConfigFile(filePath);
    return {
      filePath,
      mtimeMs: stats.mtimeMs,
      servers,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        filePath,
        servers: [],
      };
    }

    throw error;
  }
}
