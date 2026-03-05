import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export type GitFileFingerprint = {
  mtimeMs: null | number;
  size: null | number;
};

type GitSnapshot = {
  files: Map<string, GitFileFingerprint>;
};

async function runGitCommand(workingDirectory: string, args: string[]): Promise<{
  stderr: string;
  stdout: string;
  success: boolean;
}> {
  const processHandle = Bun.spawn({
    cmd: ["git", "-C", workingDirectory, ...args],
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new globalThis.Response(processHandle.stdout).text(),
    new globalThis.Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);

  return {
    stderr,
    stdout,
    success: exitCode === 0,
  };
}

async function resolveGitRepositoryRoot(workingDirectory: string): Promise<string | undefined> {
  const result = await runGitCommand(workingDirectory, ["rev-parse", "--show-toplevel"]);
  if (!result.success) {
    return undefined;
  }

  const repositoryRoot = result.stdout.trim();
  if (!repositoryRoot) {
    return undefined;
  }

  return resolve(repositoryRoot);
}

function parseGitPathList(rawOutput: string, repositoryRoot: string): Set<string> {
  const resolvedPaths = new Set<string>();
  for (const line of rawOutput.split(/\r?\n/u)) {
    const relativePath = line.trim();
    if (!relativePath) {
      continue;
    }
    resolvedPaths.add(resolve(repositoryRoot, relativePath));
  }
  return resolvedPaths;
}

async function fingerprintGitFile(filePath: string): Promise<GitFileFingerprint> {
  try {
    const fileStat = await stat(filePath);
    return {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    };
  } catch {
    return {
      mtimeMs: null,
      size: null,
    };
  }
}

export async function collectGitSnapshot(workingDirectory: string): Promise<GitSnapshot | undefined> {
  const repositoryRoot = await resolveGitRepositoryRoot(workingDirectory);
  if (!repositoryRoot) {
    return undefined;
  }

  const [workingTreeDiff, indexDiff, untrackedFiles] = await Promise.all([
    runGitCommand(repositoryRoot, ["diff", "--name-only"]),
    runGitCommand(repositoryRoot, ["diff", "--name-only", "--cached"]),
    runGitCommand(repositoryRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  const dirtyFiles = new Set<string>();
  for (const result of [workingTreeDiff, indexDiff, untrackedFiles]) {
    if (!result.success) {
      continue;
    }
    const parsed = parseGitPathList(result.stdout, repositoryRoot);
    for (const filePath of parsed) {
      dirtyFiles.add(filePath);
    }
  }

  const fingerprints = new Map<string, GitFileFingerprint>();
  const fingerprintEntries = await Promise.all(
    Array.from(dirtyFiles, async (filePath) => [
      filePath,
      await fingerprintGitFile(filePath),
    ] as const)
  );

  for (const [filePath, fingerprint] of fingerprintEntries) {
    fingerprints.set(filePath, fingerprint);
  }

  return {
    files: fingerprints,
  };
}

export function deriveChangedFilesFromGitSnapshots(
  beforeFiles: Iterable<string> | Map<string, GitFileFingerprint>,
  afterFiles: Iterable<string> | Map<string, GitFileFingerprint>
): string[] {
  const normalizeSnapshot = (
    snapshot: Iterable<string> | Map<string, GitFileFingerprint>
  ): Map<string, GitFileFingerprint | undefined> => {
    if (snapshot instanceof Map) {
      return new Map(
        Array.from(snapshot.entries(), ([filePath, fingerprint]) => [resolve(filePath), fingerprint])
      );
    }

    return new Map(
      Array.from(snapshot, (filePath) => [resolve(filePath), undefined])
    );
  };

  const beforeMap = normalizeSnapshot(beforeFiles);
  const afterMap = normalizeSnapshot(afterFiles);
  const changedFiles = new Set<string>();

  for (const filePath of afterMap.keys()) {
    const hasBefore = beforeMap.has(filePath);
    const hasAfter = afterMap.has(filePath);

    if (!hasBefore && hasAfter) {
      changedFiles.add(filePath);
      continue;
    }

    const beforeFingerprint = beforeMap.get(filePath);
    const afterFingerprint = afterMap.get(filePath);
    if (!beforeFingerprint || !afterFingerprint) {
      continue;
    }

    if (
      beforeFingerprint.mtimeMs !== afterFingerprint.mtimeMs ||
      beforeFingerprint.size !== afterFingerprint.size
    ) {
      changedFiles.add(filePath);
    }
  }

  return Array.from(changedFiles).sort((left, right) => left.localeCompare(right));
}
