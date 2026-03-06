import { join } from "node:path";

import type { BrainPaths } from "./paths";

export function buildSessionLogFileName(input: {
  date?: Date;
  runId: string;
  sessionId: string;
}): string {
  const timestamp = (input.date ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  return `session_${timestamp}_${input.sessionId}_${input.runId}.md`;
}

export function buildSessionLogPath(
  paths: BrainPaths,
  input: {
    date?: Date;
    runId: string;
    sessionId: string;
  }
): string {
  return join(paths.sessionLogsDirectory, buildSessionLogFileName(input));
}
