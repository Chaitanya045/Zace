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

const COMPLETION_SPEC_REGEX = /^\s*(?:COMPLETION_GATES|DONE_CRITERIA)\s*:\s*(.+)$/gimu;

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
