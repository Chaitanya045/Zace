import type { ToolResult } from "../../types/tool";
import type { CompletionGate } from "../completion";

import { findMaskedValidationGate } from "../completion";

export type CompletionGateResult = {
  gate: CompletionGate;
  result: ToolResult;
};

export function parsePlannerCompletionGates(commands: string[] | undefined): CompletionGate[] {
  if (!commands || commands.length === 0) {
    return [];
  }

  const gates: CompletionGate[] = [];
  const seenCommands = new Set<string>();

  for (const rawCommand of commands) {
    const command = rawCommand.trim();
    if (!command || seenCommands.has(command)) {
      continue;
    }

    seenCommands.add(command);
    gates.push({
      command,
      label: `planner:${gates.length + 1}`,
    });
  }

  return gates;
}

export function buildCompletionFailureMessage(gateResults: CompletionGateResult[]): string {
  const failedGates = gateResults.filter((gateResult) => !gateResult.result.success);
  if (failedGates.length === 0) {
    return "All completion gates passed.";
  }

  return failedGates
    .map((gateResult) => {
      const output = gateResult.result.output.replace(/\s+/gu, " ").trim();
      const detail = output.length > 180 ? `${output.slice(0, 180)}...` : output;
      return `${gateResult.gate.label} failed (${gateResult.gate.command}): ${detail}`;
    })
    .join(" | ");
}

export function shouldBlockForMaskedGates(input: {
  gateDisallowMasking: boolean;
  gates: CompletionGate[];
  strictCompletionValidation: boolean;
}) {
  if (!input.strictCompletionValidation || !input.gateDisallowMasking) {
    return undefined;
  }

  return findMaskedValidationGate(input.gates);
}

export function shouldBlockForFreshness(input: {
  lastSuccessfulValidationStep?: number;
  lastWriteStep?: number;
  strictCompletionValidation: boolean;
}): boolean {
  if (!input.strictCompletionValidation || input.lastWriteStep === undefined) {
    return false;
  }

  if (input.lastSuccessfulValidationStep === undefined) {
    return true;
  }

  return input.lastSuccessfulValidationStep < input.lastWriteStep;
}
