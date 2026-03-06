import type { MemoryGraphEdge, MemoryGraphNode } from "./types";

import { fsReadFile, fsWriteFile } from "../tools/system/fs";
import { getBrainPaths } from "./paths";
import { memoryGraphEdgesSchema, memoryGraphNodesSchema } from "./types";

export function createInitialMemoryGraphEdges(): MemoryGraphEdge[] {
  return [];
}

export function createInitialMemoryGraphNodes(): MemoryGraphNode[] {
  return [];
}

export function serializeMemoryGraphEdges(edges: MemoryGraphEdge[]): string {
  return `${JSON.stringify(edges, null, 2)}\n`;
}

export function serializeMemoryGraphNodes(nodes: MemoryGraphNode[]): string {
  return `${JSON.stringify(nodes, null, 2)}\n`;
}

type GraphConceptType = Extract<MemoryGraphNode["type"], "bug" | "decision" | "feature">;

type GraphTransitionInput = {
  changedFiles: string[];
  reasoning?: string;
  sessionId?: string;
  task: string;
  touchedFiles: string[];
  workspaceRoot?: string;
};

type GraphTransitionResult = {
  edges: MemoryGraphEdge[];
  nodes: MemoryGraphNode[];
};

function buildNodeId(type: MemoryGraphNode["type"], value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return `${type}:${slug || "unknown"}`;
}

function clipLabel(value: string, maxLength = 80): string {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 16).trimEnd()}...[truncated]`;
}

function classifyConceptTypes(text: string): GraphConceptType[] {
  const normalized = text.toLowerCase();
  const types: GraphConceptType[] = [];

  if (/\b(bug|fix|issue|error|failure|regression|broken)\b/iu.test(normalized)) {
    types.push("bug");
  }
  if (/\b(feature|implement|add|create|support|refactor|improve)\b/iu.test(normalized)) {
    types.push("feature");
  }
  if (/\b(decision|decide|architecture|architectural|convention|policy|standardize|switch)\b/iu.test(normalized)) {
    types.push("decision");
  }

  return Array.from(new Set(types));
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

function upsertEdge(
  edges: MemoryGraphEdge[],
  nextEdge: Omit<MemoryGraphEdge, "updatedAt" | "weight"> & {
    updatedAt: string;
    weight?: number;
  }
): MemoryGraphEdge[] {
  const existingIndex = edges.findIndex(
    (edge) => edge.from === nextEdge.from && edge.to === nextEdge.to && edge.type === nextEdge.type
  );
  if (existingIndex < 0) {
    return [
      ...edges,
      {
        ...nextEdge,
        weight: nextEdge.weight ?? 1,
      },
    ];
  }

  const existing = edges[existingIndex];
  if (!existing) {
    return edges;
  }

  return edges.map((edge, index) =>
    index === existingIndex
      ? {
          ...edge,
          updatedAt: nextEdge.updatedAt,
          weight: Math.max(edge.weight, nextEdge.weight ?? 1),
        }
      : edge
  );
}

function upsertNode(nodes: MemoryGraphNode[], nextNode: MemoryGraphNode): MemoryGraphNode[] {
  const existingIndex = nodes.findIndex((node) => node.id === nextNode.id);
  if (existingIndex < 0) {
    return [...nodes, nextNode];
  }

  const existing = nodes[existingIndex];
  if (!existing) {
    return nodes;
  }

  return nodes.map((node, index) =>
    index === existingIndex
      ? {
          ...node,
          description: nextNode.description ?? node.description,
          filePath: nextNode.filePath ?? node.filePath,
          label: nextNode.label,
          sessionId: nextNode.sessionId ?? node.sessionId,
          updatedAt: nextNode.updatedAt,
        }
      : node
  );
}

export async function updateMemoryGraphForTransition(
  input: GraphTransitionInput
): Promise<GraphTransitionResult> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const paths = getBrainPaths(workspaceRoot);
  const [existingNodes, existingEdges] = await Promise.all([
    parseJsonFile(paths.nodesFile, (value) => memoryGraphNodesSchema.safeParse(value), createInitialMemoryGraphNodes()),
    parseJsonFile(paths.edgesFile, (value) => memoryGraphEdgesSchema.safeParse(value), createInitialMemoryGraphEdges()),
  ]);
  const now = new Date().toISOString();
  const touchedFiles = Array.from(new Set(input.touchedFiles.filter(Boolean)));
  const changedFileSet = new Set(input.changedFiles);
  let nodes = existingNodes;
  let edges = existingEdges;

  for (const touchedFile of touchedFiles) {
    nodes = upsertNode(nodes, {
      description: changedFileSet.has(touchedFile)
        ? "Modified during agent execution."
        : "Inspected during agent execution.",
      filePath: touchedFile,
      id: buildNodeId("file", touchedFile),
      label: touchedFile,
      type: "file",
      updatedAt: now,
    });
  }

  if (input.sessionId) {
    const sessionNodeId = buildNodeId("session", input.sessionId);
    nodes = upsertNode(nodes, {
      description: clipLabel(input.task, 120),
      id: sessionNodeId,
      label: `Session ${input.sessionId}`,
      sessionId: input.sessionId,
      type: "session",
      updatedAt: now,
    });

    for (const touchedFile of touchedFiles) {
      const fileNodeId = buildNodeId("file", touchedFile);
      edges = upsertEdge(edges, {
        from: sessionNodeId,
        to: fileNodeId,
        type: changedFileSet.has(touchedFile) ? "modified_in_session" : "inspected_in_session",
        updatedAt: now,
        weight: 1,
      });
    }
  }

  const conceptText = `${input.task}\n${input.reasoning ?? ""}`.trim();
  for (const conceptType of classifyConceptTypes(conceptText)) {
    const conceptNodeId = buildNodeId(conceptType, conceptText);
    nodes = upsertNode(nodes, {
      description: clipLabel(conceptText, 160),
      id: conceptNodeId,
      label: clipLabel(input.task, 80),
      type: conceptType,
      updatedAt: now,
    });

    for (const touchedFile of touchedFiles) {
      const fileNodeId = buildNodeId("file", touchedFile);
      edges = upsertEdge(edges, {
        from: conceptNodeId,
        to: fileNodeId,
        type: "related_to_file",
        updatedAt: now,
        weight: changedFileSet.has(touchedFile) ? 2 : 1,
      });
    }
  }

  await Promise.all([
    fsWriteFile(paths.nodesFile, serializeMemoryGraphNodes(nodes), "utf8"),
    fsWriteFile(paths.edgesFile, serializeMemoryGraphEdges(edges), "utf8"),
  ]);

  return {
    edges,
    nodes,
  };
}
