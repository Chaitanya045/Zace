const DEFAULT_DOC_DISCOVERY_MAX_DEPTH = 5;
const DEFAULT_DOC_DISCOVERY_MAX_FILES = 24;
const DEFAULT_DOC_PREVIEW_MAX_CHARS = 4_000;
const DOC_CANDIDATE_MARKER_PREFIX = "ZACE_DOC_CANDIDATE|";
const DOC_MARKER_PREFIX = "ZACE_DOC";
const TARGET_DOC_BASENAME_PRIORITY = ["agents.md", "readme.md", "claude.md"] as const;

export interface ProjectDocsPolicy {
  excludedDocPaths: string[];
  skipAllDocs: boolean;
}

export type DocContextMode = "broad" | "off" | "targeted";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function quoteForSh(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function extractStdoutSection(toolOutput: string): string {
  const stdoutMatch = toolOutput.match(/\[stdout\]\n([\s\S]*?)\n\n\[stderr\]/u);
  if (!stdoutMatch?.[1]) {
    return toolOutput;
  }

  return stdoutMatch[1];
}

function shouldSkipAllDocs(task: string): boolean {
  const patterns = [
    /\b(?:do not|don't|dont|skip|ignore|avoid)\b[\s\S]{0,60}\b(?:docs?|documentation)\b/iu,
    /\bwithout\b[\s\S]{0,40}\b(?:docs?|documentation)\b/iu,
    /\bno\b[\s\S]{0,20}\b(?:docs?|documentation)\b/iu,
  ];

  return patterns.some((pattern) => pattern.test(task));
}

function shouldExcludeDoc(task: string, path: string): boolean {
  const lowerPath = path.toLowerCase();
  const baseName = lowerPath.split("/").at(-1) ?? lowerPath;
  const pathPattern = escapeRegExp(lowerPath);
  const basePattern = escapeRegExp(baseName);
  const patterns = [
    new RegExp(`\\b(?:do not|don't|dont|skip|ignore|avoid|without)\\b[\\s\\S]{0,80}\\b(?:${pathPattern}|${basePattern})\\b`, "iu"),
    new RegExp(`\\b(?:${pathPattern}|${basePattern})\\b[\\s\\S]{0,80}\\b(?:do not|don't|dont|skip|ignore|avoid|without)\\b`, "iu"),
  ];

  return patterns.some((pattern) => pattern.test(task.toLowerCase()));
}

function normalizeDiscoveredDocPath(pathValue: string): string | undefined {
  const normalized = pathValue
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/^\.\\+/u, "");

  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    return undefined;
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    return undefined;
  }

  return segments.join("/");
}

function basename(pathValue: string): string {
  const segments = pathValue.split("/");
  return (segments.at(-1) ?? pathValue).toLowerCase();
}

function depth(pathValue: string): number {
  return pathValue.split("/").length;
}

function findMatchingCandidate(
  candidates: readonly string[],
  rawReference: string
): string | undefined {
  const normalizedReference = normalizeDiscoveredDocPath(rawReference);
  if (!normalizedReference) {
    return undefined;
  }

  const lowerReference = normalizedReference.toLowerCase();
  const exactMatch = candidates.find((candidate) => candidate.toLowerCase() === lowerReference);
  if (exactMatch) {
    return exactMatch;
  }

  const referenceBaseName = basename(normalizedReference);
  const basenameMatches = candidates
    .filter((candidate) => basename(candidate) === referenceBaseName)
    .sort((left, right) => depth(left) - depth(right));
  return basenameMatches[0];
}

function extractExplicitDocReferences(task: string): string[] {
  const references = new Set<string>();
  const pattern = /\b([A-Za-z0-9_./-]+\.(?:md|txt))\b/giu;

  for (const match of task.matchAll(pattern)) {
    const candidate = normalizeDiscoveredDocPath(match[1] ?? "");
    if (candidate) {
      references.add(candidate);
    }
  }

  return Array.from(references);
}

export function selectProjectDocCandidates(input: {
  discoveredDocCandidates: readonly string[];
  maxFiles: number;
  mode: DocContextMode;
  policy: ProjectDocsPolicy;
  task: string;
}): string[] {
  if (input.mode === "off" || input.policy.skipAllDocs || input.maxFiles <= 0) {
    return [];
  }

  const excluded = new Set(input.policy.excludedDocPaths.map((path) => path.toLowerCase()));
  const discovered = input.discoveredDocCandidates.filter(
    (candidate) => !excluded.has(candidate.toLowerCase())
  );
  if (input.mode === "broad") {
    return discovered.slice(0, input.maxFiles);
  }

  const selected = new Set<string>();
  const addCandidate = (candidate?: string): void => {
    if (!candidate || excluded.has(candidate.toLowerCase())) {
      return;
    }
    selected.add(candidate);
  };

  for (const reference of extractExplicitDocReferences(input.task)) {
    addCandidate(findMatchingCandidate(discovered, reference) ?? reference);
    if (selected.size >= input.maxFiles) {
      return Array.from(selected);
    }
  }

  for (const targetBaseName of TARGET_DOC_BASENAME_PRIORITY) {
    const matches = discovered
      .filter((candidate) => basename(candidate) === targetBaseName)
      .sort((left, right) => {
        const depthDifference = depth(left) - depth(right);
        if (depthDifference !== 0) {
          return depthDifference;
        }

        return left.localeCompare(right);
      });
    addCandidate(matches[0]);
    if (selected.size >= input.maxFiles) {
      return Array.from(selected);
    }
  }

  return Array.from(selected);
}

export function buildDiscoverProjectDocsCommand(input: {
  maxDepth?: number;
  maxFiles?: number;
  platform: string;
}): string {
  const maxDepth = input.maxDepth ?? DEFAULT_DOC_DISCOVERY_MAX_DEPTH;
  const maxFiles = input.maxFiles ?? DEFAULT_DOC_DISCOVERY_MAX_FILES;

  if (input.platform === "win32") {
    const markerPrefix = quoteForPowerShell(DOC_CANDIDATE_MARKER_PREFIX);
    return [
      "$ErrorActionPreference = \"Stop\";",
      "$seen = @{};",
      "$files = Get-ChildItem -Path . -Recurse -File -Include *.md,*.txt;",
      "$files | Where-Object { $_.FullName -notmatch '[\\\\/]node_modules[\\\\/]|[\\\\/]\\.git[\\\\/]|[\\\\/]\\.zace[\\\\/]' }",
      "| ForEach-Object {",
      "  $relative = Resolve-Path -LiteralPath $_.FullName -Relative;",
      "  $normalized = $relative -replace '^[.][\\\\/]', '' -replace '\\\\', '/';",
      "  if ($normalized -match '^/|^[A-Za-z]:/' -or $normalized -match '(^|/)\\.\\.($|/)') { return }",
      "  if (-not $seen.ContainsKey($normalized)) {",
      "    $seen[$normalized] = $true;",
      `    Write-Output (${markerPrefix} + $normalized);`,
      "  }",
      "}",
      `| Select-Object -First ${String(maxFiles)};`,
    ].join(" ");
  }

  return [
    `find . -maxdepth ${String(maxDepth)} -type f \\( -iname '*.md' -o -iname '*.txt' \\)`,
    `| sed 's#^\\./##'`,
    `| grep -Ev '^(node_modules/|\\.git/|\\.zace/)'`,
    "| awk '!seen[$0]++'",
    `| head -n ${String(maxFiles)}`,
    "| while IFS= read -r path; do",
    `  printf '%s%s\\n' ${quoteForSh(DOC_CANDIDATE_MARKER_PREFIX)} "$path";`,
    "done",
  ].join(" ");
}

export function parseDiscoveredProjectDocCandidates(
  toolOutput: string,
  maxFiles: number = DEFAULT_DOC_DISCOVERY_MAX_FILES
): string[] {
  const stdout = extractStdoutSection(toolOutput);
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(DOC_CANDIDATE_MARKER_PREFIX)) {
      continue;
    }

    const rawPath = trimmed.slice(DOC_CANDIDATE_MARKER_PREFIX.length);
    const normalizedPath = normalizeDiscoveredDocPath(rawPath);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    candidates.push(normalizedPath);
    if (candidates.length >= maxFiles) {
      break;
    }
  }

  return candidates;
}

export function resolveProjectDocsPolicy(
  task: string,
  candidatePaths: readonly string[] = []
): ProjectDocsPolicy {
  const skipAllDocs = shouldSkipAllDocs(task);
  if (skipAllDocs) {
    return {
      excludedDocPaths: [...candidatePaths],
      skipAllDocs,
    };
  }

  const excludedDocPaths = candidatePaths.filter((path) => shouldExcludeDoc(task, path));
  return {
    excludedDocPaths,
    skipAllDocs,
  };
}

export function buildReadProjectDocCommand(input: {
  filePath: string;
  maxLines?: number;
  platform: string;
}): string {
  const maxLines = input.maxLines ?? 200;
  const markerPath = input.filePath;
  const beginMarker = `${DOC_MARKER_PREFIX}_BEGIN|${markerPath}`;
  const endMarker = `${DOC_MARKER_PREFIX}_END|${markerPath}`;

  if (input.platform === "win32") {
    const quotedPath = quoteForPowerShell(input.filePath);
    const quotedBegin = quoteForPowerShell(beginMarker);
    const quotedEnd = quoteForPowerShell(endMarker);
    return [
      `if (Test-Path -LiteralPath ${quotedPath}) {`,
      `  Write-Output ${quotedBegin};`,
      `  Get-Content -LiteralPath ${quotedPath} -TotalCount ${String(maxLines)};`,
      `  Write-Output ${quotedEnd};`,
      "}",
    ].join(" ");
  }

  const quotedPath = quoteForSh(input.filePath);
  const quotedBegin = quoteForSh(beginMarker);
  const quotedEnd = quoteForSh(endMarker);
  return [
    `if [ -f ${quotedPath} ]; then`,
    `printf '%s\\n' ${quotedBegin};`,
    `sed -n '1,${String(maxLines)}p' ${quotedPath};`,
    `printf '%s\\n' ${quotedEnd};`,
    "fi",
  ].join(" ");
}

export function extractProjectDocFromToolOutput(input: {
  filePath: string;
  toolOutput: string;
}): string | undefined {
  const stdout = extractStdoutSection(input.toolOutput);
  const beginMarker = `${DOC_MARKER_PREFIX}_BEGIN|${input.filePath}`;
  const endMarker = `${DOC_MARKER_PREFIX}_END|${input.filePath}`;
  const beginIndex = stdout.indexOf(beginMarker);
  if (beginIndex < 0) {
    return undefined;
  }

  const afterBegin = stdout.slice(beginIndex + beginMarker.length);
  const endIndex = afterBegin.indexOf(endMarker);
  const content = (endIndex >= 0 ? afterBegin.slice(0, endIndex) : afterBegin)
    .replace(/^\s+/u, "")
    .replace(/\s+$/u, "");

  if (!content || content === "(empty)") {
    return undefined;
  }

  return content;
}

export function truncateProjectDocPreview(
  content: string,
  maxChars: number = DEFAULT_DOC_PREVIEW_MAX_CHARS
): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}\n...[truncated]`;
}
