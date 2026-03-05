import { resolve } from "node:path";

export function deduplicatePaths(paths: Iterable<string>): string[] {
  return Array.from(
    new Set(Array.from(paths, (pathValue) => resolve(pathValue)))
  ).sort((left, right) => left.localeCompare(right));
}
