import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CompletionGate {
  command: string;
  label: string;
}

export type CompletionPlanSource = "auto_discovered" | "merged" | "none" | "planner" | "task_explicit";

export interface CompletionPlan {
  gates: CompletionGate[];
  rawSpec?: string;
  source: CompletionPlanSource;
}

export interface CompletionGateMaskingAssessment {
  isMasked: boolean;
  reason?: string;
}

export interface CompletionGateMaskingFinding {
  gate: CompletionGate;
  reason: string;
}

const COMPLETION_SPEC_REGEX = /^\s*(?:COMPLETION_GATES|DONE_CRITERIA)\s*:\s*(.+)$/gimu;

const VALIDATION_MASKING_RULES = [
  {
    reason: "contains `|| true` masking",
    regex: /\|\|\s*true(?:[\s;]|$)/u,
  },
  {
    reason: "contains `|| echo` masking",
    regex: /\|\|\s*echo(?:[\s;]|$)/u,
  },
  {
    reason: "contains `; true` masking",
    regex: /;\s*true(?:[\s;]|$)/u,
  },
  {
    reason: "contains `&& true` masking",
    regex: /&&\s*true(?:[\s;]|$)/u,
  },
  {
    reason: "contains explicit `exit 0` masking",
    regex: /\bexit\s+0(?:[\s;]|$)/u,
  },
] as const;

type ValidationKind = "lint" | "test";

const MAKEFILE_CANDIDATES = ["GNUmakefile", "Makefile", "makefile"] as const;
const JUSTFILE_CANDIDATES = ["Justfile", "justfile"] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  if (!await fileExists(path)) {
    return undefined;
  }

  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function createAutoGateBuilder() {
  const gates: CompletionGate[] = [];
  const seenCommands = new Set<string>();
  const coveredKinds = new Set<ValidationKind>();

  const addGate = (kind: ValidationKind, command: string, label: string): void => {
    const normalizedCommand = command.trim();
    if (!normalizedCommand || seenCommands.has(normalizedCommand) || coveredKinds.has(kind)) {
      return;
    }

    seenCommands.add(normalizedCommand);
    coveredKinds.add(kind);
    gates.push({
      command: normalizedCommand,
      label,
    });
  };

  return {
    addGate,
    gates,
  };
}

function pickValidationScriptName(scriptNames: string[], kind: ValidationKind): string | undefined {
  const preferredExact = kind === "lint"
    ? "lint"
    : "test";

  if (scriptNames.includes(preferredExact)) {
    return preferredExact;
  }

  if (kind === "lint") {
    return scriptNames.find((name) =>
      /(^|:)lint(?:$|:)/u.test(name) && !/(^|:)(fix|format)(:|$)/u.test(name)
    );
  }

  return scriptNames.find((name) =>
    /(^|:)test(?:$|:)/u.test(name) && !/(^|:)watch(?:$|:)/u.test(name)
  );
}

async function inferPackageScriptRunner(cwd: string, packageJson: unknown): Promise<string> {
  if (packageJson && typeof packageJson === "object") {
    const packageManager = (packageJson as { packageManager?: unknown }).packageManager;
    if (typeof packageManager === "string") {
      if (packageManager.startsWith("bun@")) {
        return "bun run";
      }
      if (packageManager.startsWith("pnpm@")) {
        return "pnpm run";
      }
      if (packageManager.startsWith("yarn@")) {
        return "yarn";
      }
      if (packageManager.startsWith("npm@")) {
        return "npm run";
      }
    }
  }

  if (await fileExists(join(cwd, "bun.lock")) || await fileExists(join(cwd, "bun.lockb"))) {
    return "bun run";
  }
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm run";
  }
  if (await fileExists(join(cwd, "yarn.lock"))) {
    return "yarn";
  }
  return "npm run";
}

async function findFirstExistingPath(cwd: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const candidatePath = join(cwd, candidate);
    if (await fileExists(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
}

function fileHasTarget(content: string, target: string): boolean {
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escapedTarget}\\s*:`, "mu").test(content);
}

function extractCompletionSpec(task: string): string | undefined {
  let match: null | RegExpExecArray;
  let lastSpec: string | undefined;

  for (match = COMPLETION_SPEC_REGEX.exec(task); match !== null; match = COMPLETION_SPEC_REGEX.exec(task)) {
    const rawSpec = match[1]?.trim();
    if (rawSpec) {
      lastSpec = rawSpec;
    }
  }

  return lastSpec;
}

function parseTaskDefinedGates(spec: string): CompletionGate[] {
  const rawTokens =
    spec.includes(";;")
      ? spec.split(";;")
      : spec.split(",");

  const parsedGates: CompletionGate[] = [];
  const seenCommands = new Set<string>();

  for (const token of rawTokens) {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      continue;
    }

    if (trimmedToken.toLowerCase() === "none") {
      continue;
    }

    const command = trimmedToken.toLowerCase().startsWith("cmd:")
      ? trimmedToken.slice(4).trim()
      : trimmedToken;
    if (!command || seenCommands.has(command)) {
      continue;
    }

    seenCommands.add(command);
    parsedGates.push({
      command,
      label: `gate:${parsedGates.length + 1}`,
    });
  }

  return parsedGates;
}

export function resolveCompletionPlan(task: string): CompletionPlan {
  const taskDefinedSpec = extractCompletionSpec(task);
  if (taskDefinedSpec) {
    const gates = parseTaskDefinedGates(taskDefinedSpec);
    return {
      gates,
      rawSpec: taskDefinedSpec,
      source: "task_explicit",
    };
  }

  return {
    gates: [],
    source: "none",
  };
}

export async function discoverAutomaticCompletionGates(workingDirectory: string): Promise<CompletionGate[]> {
  const builder = createAutoGateBuilder();
  const packageJsonPath = join(workingDirectory, "package.json");
  const packageJsonContent = await readFileIfExists(packageJsonPath);
  if (packageJsonContent) {
    try {
      const parsed = JSON.parse(packageJsonContent) as {
        scripts?: Record<string, string | undefined>;
      };
      const scripts = parsed.scripts;
      if (scripts && typeof scripts === "object") {
        const scriptNames = Object.entries(scripts)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([name]) => name);
        if (scriptNames.length > 0) {
          const runner = await inferPackageScriptRunner(workingDirectory, parsed);
          const lintScript = pickValidationScriptName(scriptNames, "lint");
          if (lintScript) {
            builder.addGate("lint", `${runner} ${lintScript}`, "auto:lint");
          }

          const testScript = pickValidationScriptName(scriptNames, "test");
          if (testScript) {
            builder.addGate("test", `${runner} ${testScript}`, "auto:test");
          }
        }
      }
    } catch {
      // Ignore invalid package.json and fall back to other task runners.
    }
  }

  const makefilePath = await findFirstExistingPath(workingDirectory, MAKEFILE_CANDIDATES);
  if (makefilePath) {
    const makefileContent = await readFileIfExists(makefilePath);
    if (makefileContent) {
      if (fileHasTarget(makefileContent, "lint")) {
        builder.addGate("lint", "make lint", "auto:lint:make");
      }
      if (fileHasTarget(makefileContent, "test")) {
        builder.addGate("test", "make test", "auto:test:make");
      }
    }
  }

  const justfilePath = await findFirstExistingPath(workingDirectory, JUSTFILE_CANDIDATES);
  if (justfilePath) {
    const justfileContent = await readFileIfExists(justfilePath);
    if (justfileContent) {
      if (fileHasTarget(justfileContent, "lint")) {
        builder.addGate("lint", "just lint", "auto:lint:just");
      }
      if (fileHasTarget(justfileContent, "test")) {
        builder.addGate("test", "just test", "auto:test:just");
      }
    }
  }

  return builder.gates;
}

export function describeCompletionPlan(plan: CompletionPlan): string[] {
  if (plan.gates.length === 0) {
    return [
      "No completion gates configured",
      "Planner should provide gates in COMPLETE response as: GATES: <command_1>;;<command_2>",
      "Or task can define gates using DONE_CRITERIA: cmd:<command_1>;;cmd:<command_2>",
      "If files changed and gates are omitted, runtime attempts auto-discovery of lint/test gates.",
    ];
  }

  return plan.gates.map((gate) => `${gate.label}: ${gate.command}`);
}

export function mergeCompletionGates(
  primary: CompletionGate[],
  secondary: CompletionGate[]
): CompletionGate[] {
  const merged: CompletionGate[] = [];
  const seenCommands = new Set<string>();

  for (const gate of [...primary, ...secondary]) {
    const normalizedCommand = gate.command.trim();
    if (!normalizedCommand || seenCommands.has(normalizedCommand)) {
      continue;
    }

    seenCommands.add(normalizedCommand);
    merged.push({
      command: normalizedCommand,
      label: gate.label,
    });
  }

  return merged;
}

export function assessValidationGateMasking(command: string): CompletionGateMaskingAssessment {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return {
      isMasked: false,
    };
  }

  for (const rule of VALIDATION_MASKING_RULES) {
    if (rule.regex.test(normalizedCommand)) {
      return {
        isMasked: true,
        reason: rule.reason,
      };
    }
  }

  return {
    isMasked: false,
  };
}

export function findMaskedValidationGate(gates: CompletionGate[]): CompletionGateMaskingFinding | undefined {
  for (const gate of gates) {
    const assessment = assessValidationGateMasking(gate.command);
    if (assessment.isMasked && assessment.reason) {
      return {
        gate,
        reason: assessment.reason,
      };
    }
  }

  return undefined;
}
