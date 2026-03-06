import type { FileImportanceMap } from "./types";

export function createInitialFileImportanceMap(): FileImportanceMap {
  return {};
}

export function serializeFileImportanceMap(fileImportance: FileImportanceMap): string {
  return `${JSON.stringify(fileImportance, null, 2)}\n`;
}
