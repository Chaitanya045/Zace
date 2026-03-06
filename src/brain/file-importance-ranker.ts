import type { FileImportanceMap, MemoryGraphEdge, MemoryGraphNode } from "./types";

import { fsReadFile, fsWriteFile } from "../tools/system/fs";
import { getBrainPaths } from "./paths";
import { fileImportanceSchema } from "./types";

export function createInitialFileImportanceMap(): FileImportanceMap {
  return {};
}

export function serializeFileImportanceMap(fileImportance: FileImportanceMap): string {
  return `${JSON.stringify(fileImportance, null, 2)}\n`;
}

async function parseJsonFile<T>(
  pathValue: string,
  safeParse: (value: unknown) => {
    data: T;
    success: boolean;
  },
  fallback: T
): Promise<T> {
  try {
    const content = await fsReadFile(pathValue, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const validated = safeParse(parsed);
    return validated.success ? validated.data : fallback;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    return fallback;
  }
}

function buildFileNodeId(pathValue: string): string {
  const slug = pathValue
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return `file:${slug || "unknown"}`;
}

function countLinkedConcepts(
  filePath: string,
  graphEdges: MemoryGraphEdge[],
  graphNodes: MemoryGraphNode[]
): number {
  const fileNodeId = buildFileNodeId(filePath);
  const conceptNodeIds = new Set(
    graphEdges
      .filter((edge) => edge.to === fileNodeId || edge.from === fileNodeId)
      .flatMap((edge) => [edge.from, edge.to])
      .filter((nodeId) => nodeId !== fileNodeId)
  );
  const conceptTypes = new Set(["bug", "decision", "feature"]);

  return graphNodes.filter(
    (node) => conceptNodeIds.has(node.id) && conceptTypes.has(node.type)
  ).length;
}

export async function recomputeTouchedFileImportance(input: {
  changedFiles: string[];
  graphEdges: MemoryGraphEdge[];
  graphNodes: MemoryGraphNode[];
  touchedFiles: string[];
  workspaceRoot?: string;
}): Promise<FileImportanceMap> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const existingMap = await parseJsonFile(
    paths.fileImportanceFile,
    (value) => fileImportanceSchema.safeParse(value),
    createInitialFileImportanceMap()
  );
  const changedFileSet = new Set(input.changedFiles);
  const touchedFiles = Array.from(new Set(input.touchedFiles.filter(Boolean)));
  const nextMap: FileImportanceMap = { ...existingMap };

  for (const touchedFile of touchedFiles) {
    const existingScore = nextMap[touchedFile] ?? 0;
    const fileNodeId = buildFileNodeId(touchedFile);
    const graphDegree = input.graphEdges.filter(
      (edge) => edge.from === fileNodeId || edge.to === fileNodeId
    ).length;
    const linkedConceptCount = countLinkedConcepts(touchedFile, input.graphEdges, input.graphNodes);
    const baseScore =
      0.12 +
      (changedFileSet.has(touchedFile) ? 0.22 : 0.07) +
      Math.min(0.24, graphDegree * 0.04) +
      Math.min(0.24, linkedConceptCount * 0.06);
    nextMap[touchedFile] = Number(
      Math.min(1, Math.max(existingScore, baseScore)).toFixed(4)
    );
  }

  await fsWriteFile(paths.fileImportanceFile, serializeFileImportanceMap(nextMap), "utf8");
  return nextMap;
}
