export interface CompletionGate {
  command: string;
  label: string;
}

export type CompletionPlanSource = "none" | "planner" | "task_explicit";

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

export function describeCompletionPlan(plan: CompletionPlan): string[] {
  if (plan.gates.length === 0) {
    return [
      "No completion gates configured",
      "Planner should provide gates in COMPLETE response as: GATES: <command_1>;;<command_2>",
      "Or task can define gates using DONE_CRITERIA: cmd:<command_1>;;cmd:<command_2>",
    ];
  }

  return plan.gates.map((gate) => `${gate.label}: ${gate.command}`);
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
