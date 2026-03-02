import type { Tool } from "../types/tool";

import { bashTool } from "./bash";
import { ToolRegistry } from "./registry";
import { sessionHistoryTools } from "./session-history";
import { shellTools } from "./shell";

export const toolRegistry = new ToolRegistry();
toolRegistry.registerAll([bashTool, ...shellTools, ...sessionHistoryTools]);

export const allTools: Tool[] = toolRegistry.list();

export function getToolByName(name: string): Tool | undefined {
  return toolRegistry.get(name);
}

export function getToolDescriptions(): string {
  return toolRegistry.getDescriptions();
}
