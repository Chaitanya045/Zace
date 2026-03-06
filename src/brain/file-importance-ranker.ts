import type { FileImportanceMap, MemoryGraphEdge, MemoryGraphNode } from "./types";

import { fsReadFile, fsWriteFile } from "../tools/system/fs";
import { getBrainPaths } from "./paths";
import { fileImportanceSchema } from "./types";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

type LinkedConceptCounts = {
  bug: number;
  decision: number;
  feature: number;
};

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

function clampUnitInterval(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/gu, "/");
}

function getFileNode(
  filePath: string,
  graphNodes: MemoryGraphNode[]
): MemoryGraphNode | undefined {
  const fileNodeId = buildFileNodeId(filePath);
  return graphNodes.find((node) => node.id === fileNodeId);
}

function getRelatedEdges(
  filePath: string,
  graphEdges: MemoryGraphEdge[]
): MemoryGraphEdge[] {
  const fileNodeId = buildFileNodeId(filePath);
  return graphEdges.filter((edge) => edge.from === fileNodeId || edge.to === fileNodeId);
}

function countSessionTouchFrequency(relatedEdges: MemoryGraphEdge[]): {
  inspected: number;
  modified: number;
} {
  let inspected = 0;
  let modified = 0;

  for (const edge of relatedEdges) {
    if (edge.type === "modified_in_session") {
      modified += 1;
      continue;
    }
    if (edge.type === "inspected_in_session") {
      inspected += 1;
    }
  }

  return {
    inspected,
    modified,
  };
}

function countLinkedConcepts(
  filePath: string,
  graphEdges: MemoryGraphEdge[],
  graphNodes: MemoryGraphNode[]
): LinkedConceptCounts {
  const fileNodeId = buildFileNodeId(filePath);
  const linkedNodeIds = new Set(
    graphEdges
      .filter((edge) => edge.to === fileNodeId || edge.from === fileNodeId)
      .flatMap((edge) => [edge.from, edge.to])
      .filter((nodeId) => nodeId !== fileNodeId)
  );

  return graphNodes.reduce<LinkedConceptCounts>(
    (counts, node) => {
      if (!linkedNodeIds.has(node.id)) {
        return counts;
      }

      if (node.type === "bug") {
        counts.bug += 1;
      } else if (node.type === "decision") {
        counts.decision += 1;
      } else if (node.type === "feature") {
        counts.feature += 1;
      }

      return counts;
    },
    {
      bug: 0,
      decision: 0,
      feature: 0,
    }
  );
}

function computeRecentTaskRelevance(input: {
  changedThisTurn: boolean;
  relatedEdges: MemoryGraphEdge[];
  updatedAt: null | string | undefined;
}): number {
  if (input.changedThisTurn) {
    return 1;
  }

  const candidateTimestamps = [
    input.updatedAt,
    ...input.relatedEdges.map((edge) => edge.updatedAt),
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  if (candidateTimestamps.length === 0) {
    return 0.15;
  }

  const mostRecentTimestamp = Math.max(...candidateTimestamps);
  const ageMs = Math.max(0, Date.now() - mostRecentTimestamp);
  if (ageMs <= DAY_IN_MS) {
    return 0.85;
  }
  if (ageMs <= 7 * DAY_IN_MS) {
    return 0.6;
  }
  if (ageMs <= 30 * DAY_IN_MS) {
    return 0.35;
  }

  return 0.15;
}

function computeFileImportanceScore(input: {
  changedThisTurn: boolean;
  existingScore: number;
  fileNode: MemoryGraphNode | undefined;
  graphEdges: MemoryGraphEdge[];
  graphNodes: MemoryGraphNode[];
  relatedEdges: MemoryGraphEdge[];
  touchedFile: string;
}): number {
  const sessionTouchFrequency = countSessionTouchFrequency(input.relatedEdges);
  const linkedConcepts = countLinkedConcepts(
    input.touchedFile,
    input.graphEdges,
    input.graphNodes
  );
  const editFrequencyScore = clampUnitInterval(
    (sessionTouchFrequency.modified * 2 + sessionTouchFrequency.inspected) / 8
  );
  const graphCentralityScore = clampUnitInterval(input.relatedEdges.length / 10);
  const conceptRiskScore = clampUnitInterval(
    (linkedConcepts.bug * 2 + linkedConcepts.decision * 1.5 + linkedConcepts.feature) / 8
  );
  const recentTaskScore = computeRecentTaskRelevance({
    changedThisTurn: input.changedThisTurn,
    relatedEdges: input.relatedEdges,
    updatedAt: input.fileNode?.updatedAt,
  });
  const computedScore =
    editFrequencyScore * 0.35 +
    conceptRiskScore * 0.25 +
    graphCentralityScore * 0.2 +
    recentTaskScore * 0.2;
  const historicalFloor = input.existingScore * 0.75;

  return Number(clampUnitInterval(Math.max(historicalFloor, computedScore)).toFixed(4));
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
  const changedFileSet = new Set(input.changedFiles.map((pathValue) => normalizePath(pathValue)));
  const touchedFiles = Array.from(
    new Set(input.touchedFiles.map((pathValue) => normalizePath(pathValue)).filter(Boolean))
  );
  const nextMap: FileImportanceMap = { ...existingMap };

  for (const touchedFile of touchedFiles) {
    const existingScore = nextMap[touchedFile] ?? 0;
    const relatedEdges = getRelatedEdges(touchedFile, input.graphEdges);
    const fileNode = getFileNode(touchedFile, input.graphNodes);

    nextMap[touchedFile] = computeFileImportanceScore({
      changedThisTurn: changedFileSet.has(touchedFile),
      existingScore,
      fileNode,
      graphEdges: input.graphEdges,
      graphNodes: input.graphNodes,
      relatedEdges,
      touchedFile,
    });
  }

  await fsWriteFile(paths.fileImportanceFile, serializeFileImportanceMap(nextMap), "utf8");
  return nextMap;
}
