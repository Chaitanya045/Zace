import type { Tool } from "../types/tool";

import { executeCommand, executeCommandSchema } from "./shell";

export const bashTool: Tool = {
  description:
    "Execute a shell command and return its output. Alias of execute_command; supports cwd, env, and timeout.",
  execute: executeCommand,
  name: "bash",
  parameters: executeCommandSchema,
};
