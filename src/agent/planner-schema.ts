const SESSION_MESSAGE_ROLE_JSON_SCHEMA = {
  enum: ["assistant", "system", "tool", "user"],
  type: "string",
};

const EXECUTE_COMMAND_TOOL_CALL_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    arguments: {
      additionalProperties: false,
      properties: {
        command: {
          minLength: 1,
          type: "string",
        },
        cwd: {
          minLength: 1,
          type: "string",
        },
        env: {
          additionalProperties: {
            type: "string",
          },
          type: "object",
        },
        maxRetries: {
          minimum: 0,
          type: "integer",
        },
        outputLimitChars: {
          minimum: 1,
          type: "integer",
        },
        retryMaxDelayMs: {
          minimum: 0,
          type: "integer",
        },
        timeout: {
          minimum: 1,
          type: "integer",
        },
      },
      required: ["command"],
      type: "object",
    },
    name: {
      const: "execute_command",
      type: "string",
    },
  },
  required: ["name", "arguments"],
  type: "object",
};

const SEARCH_SESSION_MESSAGES_TOOL_CALL_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    arguments: {
      additionalProperties: false,
      properties: {
        caseSensitive: {
          type: "boolean",
        },
        limit: {
          maximum: 200,
          minimum: 1,
          type: "integer",
        },
        query: {
          type: "string",
        },
        regex: {
          type: "boolean",
        },
        role: SESSION_MESSAGE_ROLE_JSON_SCHEMA,
        sessionId: {
          minLength: 1,
          type: "string",
        },
      },
      required: ["sessionId"],
      type: "object",
    },
    name: {
      const: "search_session_messages",
      type: "string",
    },
  },
  required: ["name", "arguments"],
  type: "object",
};

const WRITE_SESSION_MESSAGE_TOOL_CALL_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    arguments: {
      additionalProperties: false,
      properties: {
        content: {
          minLength: 1,
          type: "string",
        },
        role: SESSION_MESSAGE_ROLE_JSON_SCHEMA,
        sessionId: {
          minLength: 1,
          type: "string",
        },
        timestamp: {
          minLength: 1,
          type: "string",
        },
      },
      required: ["sessionId", "content"],
      type: "object",
    },
    name: {
      const: "write_session_message",
      type: "string",
    },
  },
  required: ["name", "arguments"],
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
    reasoning: {
      minLength: 1,
      type: "string",
    },
    toolCall: {
      oneOf: [
        EXECUTE_COMMAND_TOOL_CALL_JSON_SCHEMA,
        SEARCH_SESSION_MESSAGES_TOOL_CALL_JSON_SCHEMA,
        WRITE_SESSION_MESSAGE_TOOL_CALL_JSON_SCHEMA,
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
