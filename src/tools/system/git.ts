import { relative, resolve } from "node:path";

type GitCommandResult = {
  stderr: string;
  stdout: string;
  success: boolean;
};

export type GitChangeArtifact = {
  content: string;
  repositoryRoot: string;
  truncated: boolean;
};

async function runGitCommand(
  workingDirectory: string,
  args: string[]
): Promise<GitCommandResult> {
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

export async function resolveGitRepositoryRoot(
  workingDirectory: string
): Promise<string | undefined> {
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

function clipText(
  value: string,
  maxLength: number
): {
  truncated: boolean;
  value: string;
} {
  if (value.length <= maxLength) {
    return {
      truncated: false,
      value,
    };
  }

  return {
    truncated: true,
    value: `${value.slice(0, Math.max(0, maxLength - 32)).trimEnd()}\n...[truncated]\n`,
  };
}

function normalizeGitPaths(
  changedFiles: string[],
  repositoryRoot: string
): string[] {
  const normalizedPaths = changedFiles
    .map((filePath) => resolve(filePath))
    .filter((filePath) => filePath.startsWith(repositoryRoot))
    .map((filePath) => relative(repositoryRoot, filePath).replace(/\\/gu, "/"))
    .filter((filePath) => filePath.length > 0);

  return Array.from(new Set(normalizedPaths)).sort((left, right) => left.localeCompare(right));
}

export async function readGitChangeArtifact(input: {
  changedFiles: string[];
  maxChars?: number;
  workspaceRoot?: string;
}): Promise<GitChangeArtifact | undefined> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const repositoryRoot = await resolveGitRepositoryRoot(workspaceRoot);
  if (!repositoryRoot) {
    return undefined;
  }

  const normalizedPaths = normalizeGitPaths(input.changedFiles, repositoryRoot);
  if (normalizedPaths.length === 0) {
    return undefined;
  }

  const commandPaths = normalizedPaths.slice(0, 32);
  const [statusResult, workingTreeDiffResult, stagedDiffResult] = await Promise.all([
    runGitCommand(repositoryRoot, ["status", "--short", "--", ...commandPaths]),
    runGitCommand(repositoryRoot, ["diff", "--no-ext-diff", "--unified=1", "--", ...commandPaths]),
    runGitCommand(repositoryRoot, ["diff", "--cached", "--no-ext-diff", "--unified=1", "--", ...commandPaths]),
  ]);

  const sections = [
    "# Git Change Artifact",
    "",
    `Repository root: \`${repositoryRoot}\``,
    "",
    "## Files",
    ...commandPaths.map((filePath) => `- ${filePath}`),
    "",
    "## git status --short",
    statusResult.success && statusResult.stdout.trim().length > 0
      ? statusResult.stdout.trimEnd()
      : "No git status output available.",
    "",
    "## git diff --no-ext-diff --unified=1",
    workingTreeDiffResult.success && workingTreeDiffResult.stdout.trim().length > 0
      ? workingTreeDiffResult.stdout.trimEnd()
      : "No working tree diff output available.",
    "",
    "## git diff --cached --no-ext-diff --unified=1",
    stagedDiffResult.success && stagedDiffResult.stdout.trim().length > 0
      ? stagedDiffResult.stdout.trimEnd()
      : "No staged diff output available.",
    "",
  ].join("\n");

  const clipped = clipText(sections, input.maxChars ?? 12_000);

  return {
    content: clipped.value,
    repositoryRoot,
    truncated: clipped.truncated,
  };
}
