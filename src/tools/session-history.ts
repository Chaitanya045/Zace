import { z } from "zod";

import type { Tool, ToolResult } from "../types/tool";

import {
  appendSessionMessage,
  getSessionFilePath,
  readSessionMessages,
  sessionMessageRoleSchema,
} from "./session";

const searchSessionMessagesSchema = z.object({
  caseSensitive: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
  query: z.string().optional(),
  regex: z.boolean().optional(),
  role: sessionMessageRoleSchema.optional(),
  sessionId: z.string().min(1),
});

const writeSessionMessageSchema = z.object({
  content: z.string().min(1),
  role: sessionMessageRoleSchema.default("assistant"),
  sessionId: z.string().min(1),
  timestamp: z.string().optional(),
});

function escapeRegExpPattern(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildMatcher(input: {
  caseSensitive?: boolean;
  query?: string;
  regex?: boolean;
}): ((value: string) => boolean) | undefined {
  if (!input.query) {
    return undefined;
  }

  const source = input.regex ? input.query : escapeRegExpPattern(input.query);
  const flags = input.caseSensitive ? "u" : "iu";
  const pattern = new RegExp(source, flags);

  return (value: string) => pattern.test(value);
}

async function searchSessionMessages(args: unknown): Promise<ToolResult> {
  try {
    const {
      caseSensitive,
      limit = 20,
      query,
      regex,
      role,
      sessionId,
    } = searchSessionMessagesSchema.parse(args);

    let matcher: ((value: string) => boolean) | undefined;
    try {
      matcher = buildMatcher({
        caseSensitive,
        query,
        regex,
      });
    } catch (error) {
      return {
        error: "Invalid query pattern",
        output: `Could not compile query pattern: ${error instanceof Error ? error.message : "Unknown pattern error"}`,
        success: false,
      };
    }

    const sessionFilePath = getSessionFilePath(sessionId);
    const allMessages = await readSessionMessages(sessionId);
    const filteredByRole = role
      ? allMessages.filter((message) => message.role === role)
      : allMessages;
    const matched = matcher
      ? filteredByRole.filter((message) => matcher(message.content))
      : filteredByRole;

    const selected = matched.slice(-limit);
    const payload = {
      entries: selected.map((entry, index) => ({
        content: entry.content,
        index: matched.length - selected.length + index,
        role: entry.role,
        timestamp: entry.timestamp,
      })),
      limit,
      matchedMessages: matched.length,
      query: query ?? null,
      role: role ?? null,
      sessionFilePath,
      sessionId,
      totalMessages: allMessages.length,
    };

    return {
      output: JSON.stringify(payload, null, 2),
      success: true,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unknown error",
      output: `Failed to search session messages: ${error instanceof Error ? error.message : "Unknown error"}`,
      success: false,
    };
  }
}

async function writeSessionMessage(args: unknown): Promise<ToolResult> {
  try {
    const {
      content,
      role,
      sessionId,
      timestamp,
    } = writeSessionMessageSchema.parse(args);
    const sessionFilePath = getSessionFilePath(sessionId);

    await appendSessionMessage(sessionId, {
      content,
      role,
      timestamp,
    });

    return {
      output: JSON.stringify(
        {
          role,
          sessionFilePath,
          sessionId,
          timestamp: timestamp ?? "auto_now",
          written: true,
        },
        null,
        2
      ),
      success: true,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unknown error",
      output: `Failed to write session message: ${error instanceof Error ? error.message : "Unknown error"}`,
      success: false,
    };
  }
}

export const sessionHistoryTools: Tool[] = [
  {
    description:
      "Search messages in a session history file. Use this to retrieve older context by query, regex, or role.",
    execute: searchSessionMessages,
    name: "search_session_messages",
    parameters: searchSessionMessagesSchema,
  },
  {
    description:
      "Append a message into a session history file. Use this to persist notes or context that should survive compaction.",
    execute: writeSessionMessage,
    name: "write_session_message",
    parameters: writeSessionMessageSchema,
  },
];
