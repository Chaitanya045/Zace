import { z } from "zod";

export const submitCommandSchema = z.enum(["exit", "help", "reset", "status"]);
export type SubmitCommand = z.infer<typeof submitCommandSchema>;

export const submitPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    command: submitCommandSchema,
    kind: z.literal("command"),
  }),
  z.object({
    kind: z.literal("message"),
    text: z.string(),
  }),
]);
export type SubmitPayload = z.infer<typeof submitPayloadSchema>;

export const approvalDecisionSchema = z.enum([
  "allow_always_session",
  "allow_always_workspace",
  "allow_once",
  "deny",
]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const permissionReplySchema = z.enum(["always", "once", "reject"]);
export type PermissionReply = z.infer<typeof permissionReplySchema>;

export const chatRoleSchema = z.enum(["assistant", "system", "user"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const bridgeStateSchema = z.object({
  activeToolName: z.string().optional(),
  hasPendingApproval: z.boolean(),
  hasPendingPermission: z.boolean(),
  isBusy: z.boolean(),
  runState: z.string(),
  sessionFilePath: z.string(),
  sessionId: z.string(),
  stepLabel: z.string().optional(),
  turnCount: z.number().int().nonnegative(),
});
export type BridgeState = z.infer<typeof bridgeStateSchema>;

export const initialChatMessageSchema = z.object({
  finalState: z.string().optional(),
  role: chatRoleSchema,
  text: z.string(),
  timestamp: z.number().int().nonnegative(),
});
export type InitialChatMessage = z.infer<typeof initialChatMessageSchema>;

export const sessionListItemSchema = z.object({
  firstUserMessage: z.string().optional(),
  lastInteractedAgo: z.string().min(1),
  lastInteractedAt: z.string().min(1),
  sessionFilePath: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().min(1),
});
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

const promptOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const bridgeEventSchema = z.discriminatedUnion("type", [
  z.object({
    state: bridgeStateSchema,
    type: z.literal("state_update"),
  }),
  z.object({
    chunk: z.enum(["delta", "end", "start"]).optional(),
    finalState: z.string().optional(),
    role: chatRoleSchema,
    streamId: z.string().min(1).optional(),
    text: z.string(),
    timestamp: z.number().int().nonnegative(),
    type: z.literal("chat_message"),
  }),
  z.object({
    attempt: z.number().int().positive(),
    status: z.enum(["finished", "started"]),
    step: z.number().int().positive(),
    success: z.boolean().optional(),
    toolName: z.string(),
    type: z.literal("tool_status"),
  }),
  z.object({
    command: z.string(),
    options: z.array(promptOptionSchema),
    prompt: z.string(),
    reason: z.string(),
    type: z.literal("approval_prompt"),
  }),
  z.object({
    options: z.array(promptOptionSchema),
    patterns: z.array(z.string()),
    permission: z.string(),
    prompt: z.string(),
    type: z.literal("permission_prompt"),
  }),
  z.object({
    message: z.string(),
    type: z.literal("error"),
  }),
]);
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;

export const initRequestParamsSchema = z.object({
  sessionFilePath: z.string().min(1),
  sessionId: z.string().min(1),
  uiConfig: z.record(z.string(), z.unknown()).optional(),
});
export type InitRequestParams = z.infer<typeof initRequestParamsSchema>;

export const initResultSchema = z.object({
  messages: z.array(initialChatMessageSchema),
  state: bridgeStateSchema,
});
export type InitResult = z.infer<typeof initResultSchema>;

export const submitResultSchema = z.object({
  shouldExit: z.boolean().optional(),
});
export type SubmitResult = z.infer<typeof submitResultSchema>;

export const interruptResultSchema = z.object({
  status: z.enum(["already_requested", "not_running", "requested"]),
});
export type InterruptResult = z.infer<typeof interruptResultSchema>;

export const listSessionsResultSchema = z.object({
  sessions: z.array(sessionListItemSchema),
});
export type ListSessionsResult = z.infer<typeof listSessionsResultSchema>;

export const ackResultSchema = z.object({
  ok: z.boolean(),
});
export type AckResult = z.infer<typeof ackResultSchema>;

const requestBaseSchema = z.object({
  id: z.string().min(1),
  type: z.literal("request"),
});

export const initRequestSchema = requestBaseSchema.extend({
  method: z.literal("init"),
  params: initRequestParamsSchema,
});

export const submitRequestSchema = requestBaseSchema.extend({
  method: z.literal("submit"),
  params: submitPayloadSchema,
});

export const interruptRequestSchema = requestBaseSchema.extend({
  method: z.literal("interrupt"),
  params: z.object({}),
});

export const listSessionsRequestSchema = requestBaseSchema.extend({
  method: z.literal("list_sessions"),
  params: z.object({}),
});

export const switchSessionRequestSchema = requestBaseSchema.extend({
  method: z.literal("switch_session"),
  params: z.object({
    sessionId: z.string().min(1),
  }),
});

export const newSessionRequestSchema = requestBaseSchema.extend({
  method: z.literal("new_session"),
  params: z.object({}),
});

export const approvalReplyRequestSchema = requestBaseSchema.extend({
  method: z.literal("approval_reply"),
  params: z.object({
    decision: approvalDecisionSchema,
  }),
});

export const permissionReplyRequestSchema = requestBaseSchema.extend({
  method: z.literal("permission_reply"),
  params: z.object({
    reply: permissionReplySchema,
  }),
});

export const shutdownRequestSchema = requestBaseSchema.extend({
  method: z.literal("shutdown"),
  params: z.object({}),
});

export const bridgeClientMessageSchema = z.discriminatedUnion("method", [
  initRequestSchema,
  submitRequestSchema,
  interruptRequestSchema,
  listSessionsRequestSchema,
  switchSessionRequestSchema,
  newSessionRequestSchema,
  approvalReplyRequestSchema,
  permissionReplyRequestSchema,
  shutdownRequestSchema,
]);
export type BridgeClientMessage = z.infer<typeof bridgeClientMessageSchema>;

export const bridgeResponseSchema = z.discriminatedUnion("success", [
  z.object({
    id: z.string().min(1),
    result: z.unknown().optional(),
    success: z.literal(true),
    type: z.literal("response"),
  }),
  z.object({
    error: z.string().min(1),
    id: z.string().min(1),
    success: z.literal(false),
    type: z.literal("response"),
  }),
]);
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;

export const bridgeEventEnvelopeSchema = z.object({
  event: bridgeEventSchema,
  type: z.literal("event"),
});
export type BridgeEventEnvelope = z.infer<typeof bridgeEventEnvelopeSchema>;
