import { z } from "zod";

import type { Tool } from "../types/tool";

import { shellTools } from "./shell";

export const allTools: Tool[] = [...shellTools];

export function getToolByName(name: string): Tool | undefined {
  return allTools.find((tool) => tool.name === name);
}

export function getToolDescriptions(): string {
  return allTools
    .map((tool) => {
      const paramsInfo =
        tool.parameters instanceof z.ZodObject
          ? JSON.stringify(tool.parameters.shape, null, 2)
          : "Schema definition";
      return `- ${tool.name}: ${tool.description}\n  Parameters: ${paramsInfo}`;
    })
    .join("\n");
}
