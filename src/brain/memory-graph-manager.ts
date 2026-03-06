import type { MemoryGraphEdge, MemoryGraphNode } from "./types";

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
