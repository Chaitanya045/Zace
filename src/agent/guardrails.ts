const COMMAND_OUTPUT_LIMIT_FOR_SIGNATURE = 400;

const PYTHON_SIGNAL_PATTERNS = [
  /\bpyproject\.toml\b/iu,
  /\brequirements(?:\.[\w-]+)?\.txt\b/iu,
  /\bPipfile\b/u,
  /\bsetup\.py\b/iu,
];

const TYPESCRIPT_SIGNAL_PATTERNS = [
  /\bpackage\.json\b/iu,
  /\btsconfig(?:\.[\w-]+)?\.json\b/iu,
  /\bbun\.lockb?\b/iu,
];

const RECON_COMMAND_PATTERNS = [
  /\bls\b/iu,
  /\bdir\b/iu,
  /\bfind\b/iu,
  /\brg\b/iu,
  /\bgrep\b/iu,
  /\bcat\b/iu,
  /\bhead\b/iu,
  /\btail\b/iu,
  /\bgit\s+status\b/iu,
  /\bgit\s+ls-files\b/iu,
  /\bGet-ChildItem\b/iu,
  /\bSelect-String\b/iu,
];

const WRITE_COMMAND_PATTERNS = [
  /(^|[^<])>>?\s*[^&|]/u,
  /\btee\b/iu,
  /\btouch\b/iu,
  /\bmkdir\b/iu,
  /\bcp\b/iu,
  /\bmv\b/iu,
  /\brm\b/iu,
  /\brmdir\b/iu,
  /\btruncate\b/iu,
  /\bchmod\b/iu,
  /\bchown\b/iu,
  /\bsed\s+-i\b/iu,
  /\bperl\s+-i\b/iu,
  /\bgit\s+apply\b/iu,
];

const PYTHON_FILE_PATTERN = /\.py\b/iu;

export interface RepoGroundingState {
  hasPythonSignals: boolean;
  hasTypeScriptSignals: boolean;
  reconAttempts: number;
  repositoryInspected: boolean;
}

export function createRepoGroundingState(): RepoGroundingState {
  return {
    hasPythonSignals: false,
    hasTypeScriptSignals: false,
    reconAttempts: 0,
    repositoryInspected: false,
  };
}

export function buildInitialRepoReconCommand(platform: string): string {
  if (platform === "win32") {
    return "Get-ChildItem -Force | Select-Object Mode,Length,Name";
  }

  return "ls -la";
}

export function isLikelyReconCommand(command: string): boolean {
  return RECON_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function isLikelyWriteCommand(command: string): boolean {
  return WRITE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function hasExplicitPythonPreference(task: string): boolean {
  return /\bpython\b|\.py\b/iu.test(task);
}

function detectProjectSignalsFromText(text: string): {
  hasPythonSignals: boolean;
  hasTypeScriptSignals: boolean;
} {
  const hasPythonSignals = PYTHON_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
  const hasTypeScriptSignals = TYPESCRIPT_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));

  return {
    hasPythonSignals,
    hasTypeScriptSignals,
  };
}

export function recordCommandObservation(input: {
  command: string;
  output: string;
  state: RepoGroundingState;
  success: boolean;
}): RepoGroundingState {
  const commandText = input.command.trim();
  if (!commandText || !input.success) {
    return input.state;
  }

  const detectedSignals = detectProjectSignalsFromText(input.output);
  const inspectionFromCommand = isLikelyReconCommand(commandText);
  const inspectionFromSignals = detectedSignals.hasPythonSignals || detectedSignals.hasTypeScriptSignals;

  return {
    hasPythonSignals: input.state.hasPythonSignals || detectedSignals.hasPythonSignals,
    hasTypeScriptSignals: input.state.hasTypeScriptSignals || detectedSignals.hasTypeScriptSignals,
    reconAttempts: input.state.reconAttempts + (inspectionFromCommand ? 1 : 0),
    repositoryInspected:
      input.state.repositoryInspected ||
      inspectionFromCommand ||
      inspectionFromSignals,
  };
}

export function shouldRunReconBeforeCommand(command: string, state: RepoGroundingState): boolean {
  if (!isLikelyWriteCommand(command)) {
    return false;
  }

  return !state.repositoryInspected;
}

export function getLanguageMismatchReason(input: {
  command: string;
  state: RepoGroundingState;
  task: string;
}): null | string {
  if (!isLikelyWriteCommand(input.command)) {
    return null;
  }

  if (hasExplicitPythonPreference(input.task)) {
    return null;
  }

  if (
    input.state.hasTypeScriptSignals &&
    !input.state.hasPythonSignals &&
    PYTHON_FILE_PATTERN.test(input.command)
  ) {
    return "Repository appears TypeScript-first. Use TypeScript/JavaScript file extensions unless the user explicitly asks for Python.";
  }

  return null;
}

function normalizeOutputForSignature(output: string): string {
  return output
    .replace(/stdout:\s+[^\n]+/giu, "stdout:<artifact>")
    .replace(/stderr:\s+[^\n]+/giu, "stderr:<artifact>")
    .replace(/combined:\s+[^\n]+/giu, "combined:<artifact>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, "<uuid>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, COMMAND_OUTPUT_LIMIT_FOR_SIGNATURE);
}

export function buildToolLoopSignature(input: {
  argumentsObject: Record<string, unknown>;
  output: string;
  success: boolean;
  toolName: string;
}): string {
  const normalizedOutput = normalizeOutputForSignature(input.output);
  return [
    input.toolName,
    JSON.stringify(input.argumentsObject),
    input.success ? "success" : "failure",
    normalizedOutput,
  ].join("|");
}
