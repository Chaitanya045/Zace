import { PLANNER_TOOL_CALL_JSON_SCHEMAS } from "./planner/tools";

const PLANNER_PLAN_STEP_JSON_SCHEMA: Record<string, unknown> = {
  additionalProperties: false,
  properties: {
    id: {
      minLength: 1,
      type: "string",
    },
    relevantFiles: {
      items: {
        minLength: 1,
        type: "string",
      },
      type: "array",
    },
    status: {
      enum: ["completed", "in_progress", "pending"],
      type: "string",
    },
    title: {
      minLength: 1,
      type: "string",
    },
  },
  required: ["id", "status", "title"],
  type: "object",
};

const PLANNER_PLAN_STATE_JSON_SCHEMA: Record<string, unknown> = {
  additionalProperties: false,
  properties: {
    currentStepId: {
      oneOf: [
        {
          minLength: 1,
          type: "string",
        },
        {
          type: "null",
        },
      ],
    },
    goal: {
      oneOf: [
        {
          minLength: 1,
          type: "string",
        },
        {
          type: "null",
        },
      ],
    },
    steps: {
      items: PLANNER_PLAN_STEP_JSON_SCHEMA,
      type: "array",
    },
  },
  required: ["currentStepId", "goal", "steps"],
  type: "object",
};

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
    planState: PLANNER_PLAN_STATE_JSON_SCHEMA,
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
