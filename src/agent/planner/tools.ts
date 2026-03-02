import { z } from "zod";

import { toolRegistry } from "../../tools";

const SESSION_MESSAGE_ROLE_JSON_SCHEMA = {
  enum: ["assistant", "system", "tool", "user"],
  type: "string",
} as const;

function normalizeJsonSchemaForTransport(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const rootSchema = schema as Record<string, unknown>;
  if (typeof rootSchema.$schema === "string") {
    rootSchema.$schema = "http://json-schema.org/draft-07/schema#";
  }
  return rootSchema;
}

function buildToolCallJsonSchema(toolName: string): Record<string, unknown> {
  const tool = toolRegistry.get(toolName);
  if (!tool) {
    throw new Error(`Planner tool not registered: ${toolName}`);
  }

  const toolArgsSchema = z.toJSONSchema(tool.parameters, { target: "draft-07" });
  const normalizedArgs = normalizeJsonSchemaForTransport(toolArgsSchema) as Record<string, unknown>;

  return {
    additionalProperties: false,
    properties: {
      arguments: normalizedArgs,
      name: {
        const: toolName,
        type: "string",
      },
    },
    required: ["name", "arguments"],
    type: "object",
  };
}

export const PLANNER_TOOL_NAMES = [
  "bash",
  "execute_command",
  "search_session_messages",
  "write_session_message",
] as const;

export type PlannerToolName = (typeof PLANNER_TOOL_NAMES)[number];

export const PLANNER_TOOL_CALL_JSON_SCHEMAS = {
  bash: buildToolCallJsonSchema("bash"),
  execute_command: buildToolCallJsonSchema("execute_command"),
  search_session_messages: buildToolCallJsonSchema("search_session_messages"),
  write_session_message: buildToolCallJsonSchema("write_session_message"),
} as const;

export const PLANNER_SESSION_MESSAGE_ROLE_JSON_SCHEMA = SESSION_MESSAGE_ROLE_JSON_SCHEMA;
