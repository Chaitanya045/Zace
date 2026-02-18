import { isAbsolute, resolve } from "node:path";

const OVERWRITE_REDIRECT_TARGET_REGEX = /(?:^|[\s;|&])(?:\d*)>(?!>|&)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/gu;
const ZACE_MARKER_LINE_REGEX = /^ZACE_[A-Z0-9_]+\|.*$/u;
const ZACE_FILE_CHANGED_PREFIX = "ZACE_FILE_CHANGED|";

function normalizeCommandPath(pathValue: string, workingDirectory: string): string {
  const trimmed = pathValue.trim().replace(/^["']|["']$/gu, "");
  if (!trimmed) {
    return "";
  }

  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }

  return resolve(workingDirectory, trimmed);
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function isDynamicShellPath(value: string): boolean {
  return /[`$*?{}()]/u.test(value);
}

export function collectZaceMarkerLines(stdout: string, stderr: string): string[] {
  const markerLines: string[] = [];
  const seen = new Set<string>();

  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || !ZACE_MARKER_LINE_REGEX.test(trimmed) || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    markerLines.push(trimmed);
  }

  return markerLines;
}

export function inferChangedFilesFromRedirectTargets(
  command: string,
  workingDirectory: string
): string[] {
  const inferredChangedFiles = new Set<string>();

  for (const match of command.matchAll(OVERWRITE_REDIRECT_TARGET_REGEX)) {
    const rawTarget = match[1];
    if (!rawTarget) {
      continue;
    }

    const normalizedTarget = stripWrappingQuotes(rawTarget.trim());
    if (
      !normalizedTarget ||
      normalizedTarget === "-" ||
      normalizedTarget === "/dev/null" ||
      normalizedTarget.toLowerCase() === "nul" ||
      normalizedTarget.startsWith("~") ||
      isDynamicShellPath(normalizedTarget)
    ) {
      continue;
    }

    const resolvedTarget = normalizeCommandPath(normalizedTarget, workingDirectory);
    if (!resolvedTarget) {
      continue;
    }
    inferredChangedFiles.add(resolvedTarget);
  }

  return Array.from(inferredChangedFiles).sort((left, right) => left.localeCompare(right));
}

export function parseChangedFilesFromMarkerLines(
  markerLines: string[],
  workingDirectory: string
): string[] {
  const changedFiles = new Set<string>();

  for (const markerLine of markerLines) {
    if (!markerLine.startsWith(ZACE_FILE_CHANGED_PREFIX)) {
      continue;
    }

    const rawPath = markerLine.slice(ZACE_FILE_CHANGED_PREFIX.length).trim();
    if (!rawPath) {
      continue;
    }

    const normalized = normalizeCommandPath(rawPath, workingDirectory);
    if (!normalized) {
      continue;
    }
    changedFiles.add(normalized);
  }

  return Array.from(changedFiles).sort((left, right) => left.localeCompare(right));
}
