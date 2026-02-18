import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PlannerOutputMode } from "../../config/env";

const PLANNER_INVALID_ARTIFACTS_DIRECTORY = ".zace/runtime/planner";

export type InvalidPlannerAttempt = {
  content: string;
  parseReason: string;
  transportStructured: boolean;
};

function truncateForArtifact(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n...[truncated ${String(content.length - maxChars)} chars]`;
}

export async function persistInvalidPlannerOutputArtifact(input: {
  attempts: InvalidPlannerAttempt[];
  maxChars: number;
  outputMode: PlannerOutputMode;
}): Promise<string | undefined> {
  if (input.attempts.length === 0) {
    return undefined;
  }

  const artifactDirectory = resolve(PLANNER_INVALID_ARTIFACTS_DIRECTORY);
  await mkdir(artifactDirectory, { recursive: true });
  const artifactPath = join(
    artifactDirectory,
    `invalid-${Date.now().toString()}-${randomUUID().replace(/-/gu, "").slice(0, 8)}.json`
  );

  const payload = {
    attempts: input.attempts.map((attempt, index) => ({
      attempt: index + 1,
      parseReason: attempt.parseReason,
      response: truncateForArtifact(attempt.content, input.maxChars),
      transportStructured: attempt.transportStructured,
    })),
    outputMode: input.outputMode,
    timestamp: new Date().toISOString(),
  };

  await writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return artifactPath;
}
