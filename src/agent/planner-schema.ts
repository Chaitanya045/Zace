import { PLANNER_TOOL_CALL_JSON_SCHEMAS } from "./planner/tools";

export const PLANNER_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: {
          action: {
            const: "continue",
            type: "string",
          },
        },
        required: ["action"],
      },
      then: {
        required: ["toolCall"],
      },
    },
  ],
  properties: {
    action: {
      enum: ["continue", "ask_user", "blocked", "complete"],
      type: "string",
    },
    gates: {
      oneOf: [
        {
          items: {
            minLength: 1,
            type: "string",
          },
          type: "array",
        },
        {
          const: "none",
          type: "string",
        },
      ],
    },
    reasoning: {
      minLength: 1,
      type: "string",
    },
    toolCall: {
      oneOf: [
        PLANNER_TOOL_CALL_JSON_SCHEMAS.execute_command,
        PLANNER_TOOL_CALL_JSON_SCHEMAS.bash,
        PLANNER_TOOL_CALL_JSON_SCHEMAS.search_session_messages,
        PLANNER_TOOL_CALL_JSON_SCHEMAS.write_session_message,
      ],
    },
    userMessage: {
      minLength: 1,
      type: "string",
    },
  },
  required: ["action", "reasoning"],
  type: "object",
};
