import { z } from "zod";

import type { Tool } from "../types/tool";

export class ToolRegistry {
  readonly #toolsByName = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.#toolsByName.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#toolsByName.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.#toolsByName.get(name);
  }

  list(): Tool[] {
    return Array.from(this.#toolsByName.values());
  }

  getDescriptions(): string {
    return this.list()
      .map((tool) => {
        const paramsInfo =
          tool.parameters instanceof z.ZodObject
            ? JSON.stringify(tool.parameters.shape, null, 2)
            : "Schema definition";
        return `- ${tool.name}: ${tool.description}\n  Parameters: ${paramsInfo}`;
      })
      .join("\n");
  }
}
