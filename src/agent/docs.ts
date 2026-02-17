const DEFAULT_DOC_PREVIEW_MAX_CHARS = 4_000;
const DOC_MARKER_PREFIX = "ZACE_DOC";

export const PROJECT_DOC_CANDIDATE_PATHS = [
  "AGENTS.md",
  "README.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/CONTRIBUTING.md",
] as const;

export interface ProjectDocsPolicy {
  excludedDocPaths: string[];
  skipAllDocs: boolean;
}

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

export function resolveProjectDocsPolicy(
  task: string,
  candidatePaths: readonly string[] = PROJECT_DOC_CANDIDATE_PATHS
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
