import type {
  OpenPendingApproval,
  ApprovalRuleScope,
} from "../../agent/approval";
import type { AgentObserver } from "../../agent/observer";
import type { LlmClient } from "../../llm/client";
import type { OpenPendingPermission } from "../../permission/pending";
import type { AgentConfig } from "../../types/config";
import type {
  ApprovalDecision,
  BridgeEvent,
  BridgeState,
  InitResult,
  InterruptResult,
  ListSessionsResult,
  SubmitPayload,
  SubmitResult,
} from "./protocol";

import {
  resolvePendingApprovalAction,
  storeApprovalRule,
} from "../../agent/approval";
import {
  buildChatTaskWithFollowUpFromSession,
  createAutoSessionId,
  loadSessionState,
  resolvePendingApprovalFromUserMessage,
  type ChatTurn,
} from "../../cli/chat-session";
import { PermissionNext } from "../../permission/next";
import { resolvePendingPermissionAction } from "../../permission/pending";
import { findOpenPendingPermission, resolvePendingPermissionFromUserMessage } from "../../permission/resolve";
import { storePermissionRule } from "../../permission/store";
import { SessionProcessor } from "../../session/processor/session-processor";
import { scheduleSessionTitleFromFirstUserMessage } from "../../session/session-title";
import {
  appendSessionApprovalRule,
  getSessionFilePath,
  listSessionCatalog,
  normalizeSessionId,
} from "../../tools/session";
import { fsStat } from "../../tools/system/fs";

const HELP_TEXT = [
  "Keyboard shortcuts:",
  "- Enter: submit message",
  "- Ctrl+P: open command palette",
  "- Ctrl+C: interrupt running turn (press again to force exit)",
  "- F1 or ?: open help",
].join("\n");

const STATUS_PROMPT_OPTIONS = {
  approval: [
    { id: "allow_once", label: "Allow once" },
    { id: "allow_always_session", label: "Allow always (session)" },
    { id: "allow_always_workspace", label: "Allow always (workspace)" },
    { id: "deny", label: "Deny" },
  ],
  permission: [
    { id: "once", label: "Allow once" },
    { id: "always", label: "Allow always" },
    { id: "reject", label: "Reject" },
  ],
} as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function splitForStreaming(text: string): string[] {
  if (!text) {
    return [];
  }

  const targetChunks = Math.min(80, Math.max(1, Math.ceil(text.length / 24)));
  const chunkSize = Math.max(8, Math.ceil(text.length / targetChunks));
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }

  return chunks;
}

type BridgeControllerInput = {
  client: LlmClient;
  config: AgentConfig;
  emitEvent: (event: BridgeEvent) => void;
  sessionFilePath: string;
  sessionId: string;
};

export class BridgeController {
  private readonly client: LlmClient;
  private readonly config: AgentConfig;
  private readonly emitEvent: (event: BridgeEvent) => void;
  private sessionFilePath: string;
  private sessionId: string;

  private state: BridgeState;
  private turns: ChatTurn[] = [];
  private pendingApproval: OpenPendingApproval | undefined;
  private pendingPermission: null | OpenPendingPermission = null;
  private pendingFollowUpQuestion: string | undefined;
  private activeAbortController: globalThis.AbortController | undefined;
  private interruptRequested = false;
  private approvedCommandSignaturesOnce: string[] = [];
  private approvedPermissionsOnce: Array<{ pattern: string; permission: string }> = [];
  private queuedResolutionNotes: string[] = [];
  private assistantStreamCounter = 0;

  constructor(input: BridgeControllerInput) {
    this.client = input.client;
    this.config = input.config;
    this.emitEvent = input.emitEvent;
    this.sessionFilePath = input.sessionFilePath;
    this.sessionId = input.sessionId;
    this.state = {
      hasPendingApproval: false,
      hasPendingPermission: false,
      isBusy: false,
      runState: "idle",
      sessionFilePath: this.sessionFilePath,
      sessionId: this.sessionId,
      turnCount: 0,
    };
  }

  async init(): Promise<InitResult> {
    return this.loadActiveSession();
  }

  async listSessions(): Promise<ListSessionsResult> {
    const catalog = await listSessionCatalog();
    return {
      sessions: catalog.map((session) => ({
        ...session,
        title:
          typeof session.title === "string" && session.title.trim().length > 0
            ? session.title
            : `Session ${session.sessionId}`,
      })),
    };
  }

  async switchSession(sessionId: string): Promise<InitResult> {
    if (this.state.isBusy) {
      throw new Error("Cannot switch session while run is active.");
    }

    const normalizedSessionId = normalizeSessionId(sessionId);
    const nextSessionPath = getSessionFilePath(normalizedSessionId);
    try {
      const fileStat = await fsStat(nextSessionPath);
      if (!fileStat.isFile()) {
        throw new Error("Session path is not a file.");
      }
    } catch {
      throw new Error("Session not found in current directory.");
    }

    this.sessionId = normalizedSessionId;
    this.sessionFilePath = nextSessionPath;
    this.resetSessionRuntimeState();
    return this.loadActiveSession();
  }

  async newSession(): Promise<InitResult> {
    if (this.state.isBusy) {
      throw new Error("Cannot switch session while run is active.");
    }

    const newSessionId = createAutoSessionId();
    this.sessionId = newSessionId;
    this.sessionFilePath = getSessionFilePath(newSessionId);
    this.resetSessionRuntimeState();
    return this.loadActiveSession();
  }

  private resetSessionRuntimeState(): void {
    this.turns = [];
    this.pendingApproval = undefined;
    this.pendingPermission = null;
    this.pendingFollowUpQuestion = undefined;
    this.activeAbortController = undefined;
    this.interruptRequested = false;
    this.approvedCommandSignaturesOnce = [];
    this.approvedPermissionsOnce = [];
    this.queuedResolutionNotes = [];
    this.assistantStreamCounter = 0;
  }

  private async loadActiveSession(): Promise<InitResult> {
    const sessionState = await loadSessionState(
      this.sessionId,
      this.config.pendingActionMaxAgeMs,
      this.config.approvalMemoryEnabled,
      this.config.interruptedRunRecoveryEnabled
    );

    this.turns = [...sessionState.turns];
    this.pendingApproval = sessionState.pendingApproval;
    this.pendingPermission = await findOpenPendingPermission({
      maxAgeMs: this.config.pendingActionMaxAgeMs,
      sessionId: this.sessionId,
    });
    this.pendingFollowUpQuestion = sessionState.pendingFollowUpQuestion;

    this.updateState({
      activeToolName: undefined,
      hasPendingApproval: Boolean(this.pendingApproval),
      hasPendingPermission: Boolean(this.pendingPermission),
      isBusy: false,
      runState: this.pendingFollowUpQuestion ? "waiting_for_user" : "idle",
      sessionFilePath: this.sessionFilePath,
      sessionId: this.sessionId,
      stepLabel: undefined,
      turnCount: this.turns.length,
    });

    if (this.pendingApproval) {
      this.emitApprovalPrompt(this.pendingApproval);
    }
    if (this.pendingPermission) {
      this.emitPermissionPrompt(this.pendingPermission);
    }

    return {
      messages: this.buildInitialChatMessages(this.turns),
      state: this.state,
    };
  }

  async submit(payload: SubmitPayload): Promise<SubmitResult> {
    if (payload.kind === "command") {
      return this.handleCommand(payload.command);
    }

    const rawMessage = payload.text;
    const message = rawMessage.trim();
    if (!message) {
      return {};
    }

    const compatibilityCommand = this.parseCompatibilityCommand(message);
    if (compatibilityCommand) {
      return this.handleCommand(compatibilityCommand);
    }

    if (this.state.isBusy) {
      this.emitChatMessage(
        "system",
        "Agent is currently running. Wait for completion before sending another message."
      );
      return {};
    }

    this.emitChatMessage("user", message);
    await this.runUserMessage(message);
    return {};
  }

  async interrupt(): Promise<InterruptResult> {
    if (!this.state.isBusy || !this.activeAbortController) {
      return {
        status: "not_running",
      };
    }

    if (this.interruptRequested || this.activeAbortController.signal.aborted) {
      return {
        status: "already_requested",
      };
    }

    this.interruptRequested = true;
    this.activeAbortController.abort();
    this.emitChatMessage(
      "system",
      "Interrupt requested. Waiting for current step to stop. Press Ctrl+C again to force exit."
    );
    return {
      status: "requested",
    };
  }

  async approvalReply(decision: ApprovalDecision): Promise<{ ok: boolean }> {
    if (!this.pendingApproval) {
      throw new Error("No pending approval to resolve.");
    }

    const resolution = await this.resolveApprovalDecision(decision, this.pendingApproval);
    this.pendingApproval = undefined;
    this.pendingFollowUpQuestion = undefined;

    if (resolution.contextNote) {
      this.queuedResolutionNotes.push(resolution.contextNote);
    }
    if (resolution.commandSignature) {
      this.approvedCommandSignaturesOnce.push(resolution.commandSignature);
    }

    this.updateState({
      hasPendingApproval: false,
      runState: "idle",
    });
    this.emitChatMessage("system", resolution.message);

    return {
      ok: true,
    };
  }

  async permissionReply(reply: PermissionNext.Reply): Promise<{ ok: boolean }> {
    if (!this.pendingPermission) {
      throw new Error("No pending permission to resolve.");
    }

    const resolution = await this.resolvePermissionDecision(reply, this.pendingPermission);
    this.pendingPermission = null;
    this.pendingFollowUpQuestion = undefined;

    if (resolution.contextNote) {
      this.queuedResolutionNotes.push(resolution.contextNote);
    }
    if (resolution.allowOnce.length > 0) {
      this.approvedPermissionsOnce.push(...resolution.allowOnce);
    }

    this.updateState({
      hasPendingPermission: false,
      runState: "idle",
    });
    this.emitChatMessage("system", resolution.message);

    return {
      ok: true,
    };
  }

  async shutdown(): Promise<void> {
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort();
    }
  }

  private buildInitialChatMessages(turns: ChatTurn[]): InitResult["messages"] {
    const start = Date.now();
    const messages: InitResult["messages"] = [];

    turns.forEach((turn, index) => {
      const baseTime = start + index;
      messages.push({
        role: "user",
        text: turn.user,
        timestamp: baseTime,
      });
      messages.push({
        finalState: turn.finalState,
        role: "assistant",
        text: turn.assistant,
        timestamp: baseTime,
      });
    });

    return messages;
  }

  private parseCompatibilityCommand(message: string): "exit" | "help" | "reset" | "status" | null {
    switch (message.toLowerCase()) {
      case "/exit":
        return "exit";
      case "/help":
        return "help";
      case "/reset":
        return "reset";
      case "/status":
        return "status";
      default:
        return null;
    }
  }

  private updateState(patch: Partial<BridgeState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.emitEvent({
      state: this.state,
      type: "state_update",
    });
  }

  private emitChatMessage(
    role: "assistant" | "system" | "user",
    text: string,
    finalState?: string
  ): void {
    this.emitEvent({
      finalState,
      role,
      text,
      timestamp: Date.now(),
      type: "chat_message",
    });
  }

  private async emitAssistantMessage(text: string, finalState?: string): Promise<void> {
    const streamId = `assistant-${String(Date.now())}-${String(this.assistantStreamCounter)}`;
    this.assistantStreamCounter += 1;

    this.emitEvent({
      chunk: "start",
      role: "assistant",
      streamId,
      text: "",
      timestamp: Date.now(),
      type: "chat_message",
    });

    for (const chunk of splitForStreaming(text)) {
      this.emitEvent({
        chunk: "delta",
        role: "assistant",
        streamId,
        text: chunk,
        timestamp: Date.now(),
        type: "chat_message",
      });
      await delay(12);
    }

    this.emitEvent({
      chunk: "end",
      finalState,
      role: "assistant",
      streamId,
      text: "",
      timestamp: Date.now(),
      type: "chat_message",
    });
  }

  private emitApprovalPrompt(pendingApproval: OpenPendingApproval): void {
    this.emitEvent({
      command: pendingApproval.context.command,
      options: [...STATUS_PROMPT_OPTIONS.approval],
      prompt: pendingApproval.entry.prompt,
      reason: pendingApproval.context.reason,
      type: "approval_prompt",
    });
  }

  private emitPermissionPrompt(pendingPermission: OpenPendingPermission): void {
    this.emitEvent({
      options: [...STATUS_PROMPT_OPTIONS.permission],
      patterns: pendingPermission.context.patterns,
      permission: pendingPermission.context.permission,
      prompt: pendingPermission.entry.prompt,
      type: "permission_prompt",
    });
  }

  private consumeResolutionNotes(): string | undefined {
    if (this.queuedResolutionNotes.length === 0) {
      return undefined;
    }

    const merged = this.queuedResolutionNotes.join("\n\n");
    this.queuedResolutionNotes = [];
    return merged;
  }

  private consumeApprovedCommandSignaturesOnce(): string[] | undefined {
    if (this.approvedCommandSignaturesOnce.length === 0) {
      return undefined;
    }

    const values = [...this.approvedCommandSignaturesOnce];
    this.approvedCommandSignaturesOnce = [];
    return values;
  }

  private consumeApprovedPermissionsOnce():
    | Array<{
        pattern: string;
        permission: string;
      }>
    | undefined {
    if (this.approvedPermissionsOnce.length === 0) {
      return undefined;
    }

    const values = [...this.approvedPermissionsOnce];
    this.approvedPermissionsOnce = [];
    return values;
  }

  private async handleCommand(command: "exit" | "help" | "reset" | "status"): Promise<SubmitResult> {
    switch (command) {
      case "status": {
        this.emitChatMessage("system", this.buildStatusText());
        return {};
      }
      case "help": {
        this.emitChatMessage("system", HELP_TEXT);
        return {};
      }
      case "reset": {
        this.turns = [];
        this.pendingApproval = undefined;
        this.pendingPermission = null;
        this.pendingFollowUpQuestion = undefined;
        this.approvedCommandSignaturesOnce = [];
        this.approvedPermissionsOnce = [];
        this.queuedResolutionNotes = [];
        this.updateState({
          activeToolName: undefined,
          hasPendingApproval: false,
          hasPendingPermission: false,
          runState: "idle",
          stepLabel: undefined,
          turnCount: 0,
        });
        this.emitChatMessage("system", "Conversation context reset in memory. Session file remains unchanged.");
        return {};
      }
      case "exit": {
        return {
          shouldExit: true,
        };
      }
      default:
        return {};
    }
  }

  private buildStatusText(): string {
    return [
      `Turns: ${String(this.turns.length)}`,
      `Busy: ${this.state.isBusy ? "yes" : "no"}`,
      `Run state: ${this.state.runState}`,
      `Pending follow-up: ${this.pendingFollowUpQuestion ? "yes" : "no"}`,
      `Pending approval: ${this.pendingApproval ? "yes" : "no"}`,
      `Pending permission: ${this.pendingPermission ? "yes" : "no"}`,
      `Active tool: ${this.state.activeToolName ?? "none"}`,
    ].join("\n");
  }

  private async runUserMessage(message: string): Promise<void> {
    this.updateState({
      isBusy: true,
      runState: "running",
      stepLabel: "step:n/a",
    });

    const followUpQuestionForTask = this.pendingFollowUpQuestion;
    let approvalResolutionNote = this.consumeResolutionNotes();

    if (this.pendingApproval) {
      const resolution = await resolvePendingApprovalFromUserMessage({
        client: this.client,
        config: this.config,
        pendingApproval: this.pendingApproval,
        sessionId: this.sessionId,
        userInput: message,
      });

      if (resolution?.status === "unclear") {
        await this.emitAssistantMessage(resolution.message);
        this.updateState({
          isBusy: false,
          runState: "waiting_for_user",
          stepLabel: undefined,
        });
        this.emitApprovalPrompt(this.pendingApproval);
        return;
      }

      if (resolution?.status === "resolved") {
        this.pendingApproval = undefined;
        this.pendingFollowUpQuestion = undefined;
        this.updateState({
          hasPendingApproval: false,
        });
        this.emitChatMessage("system", resolution.message);
        if (resolution.contextNote) {
          approvalResolutionNote = approvalResolutionNote
            ? `${approvalResolutionNote}\n\n${resolution.contextNote}`
            : resolution.contextNote;
        }
        if (resolution.scope === "once" && resolution.commandSignature) {
          this.approvedCommandSignaturesOnce.push(resolution.commandSignature);
        }
      }
    }

    if (this.pendingPermission) {
      const resolution = await resolvePendingPermissionFromUserMessage({
        config: this.config,
        pending: this.pendingPermission,
        sessionId: this.sessionId,
        userInput: message,
      });

      if (resolution.status === "unclear") {
        await this.emitAssistantMessage(resolution.message);
        this.updateState({
          isBusy: false,
          runState: "waiting_for_user",
          stepLabel: undefined,
        });
        this.emitPermissionPrompt(this.pendingPermission);
        return;
      }

      if (resolution.status === "resolved") {
        this.pendingPermission = null;
        this.pendingFollowUpQuestion = undefined;
        this.updateState({
          hasPendingPermission: false,
        });
        this.emitChatMessage("system", resolution.message);
        if (resolution.contextNote) {
          approvalResolutionNote = approvalResolutionNote
            ? `${approvalResolutionNote}\n\n${resolution.contextNote}`
            : resolution.contextNote;
        }
        if (resolution.allowOnce && resolution.allowOnce.length > 0) {
          this.approvedPermissionsOnce.push(...resolution.allowOnce);
        }
      }
    }

    const task = await buildChatTaskWithFollowUpFromSession({
      approvalResolutionNote,
      followUpQuestion: followUpQuestionForTask,
      sessionId: this.sessionId,
      userInput: message,
    });

    const observer: AgentObserver = {
      onError: (event) => {
        this.emitEvent({
          message: event.message,
          type: "error",
        });
      },
      onStepStart: (event) => {
        this.updateState({
          stepLabel: `step:${String(event.step)}/${String(event.maxSteps)}`,
        });
      },
      onToolCall: (event) => {
        this.updateState({
          activeToolName: event.name,
        });
        this.emitEvent({
          attempt: event.attempt,
          status: "started",
          step: event.step,
          toolName: event.name,
          type: "tool_status",
        });
      },
      onToolResult: (event) => {
        this.updateState({
          activeToolName: undefined,
        });
        this.emitEvent({
          attempt: event.attempt,
          status: "finished",
          step: event.step,
          success: event.success,
          toolName: event.name,
          type: "tool_status",
        });
      },
    };

    const abortController = new globalThis.AbortController();
    this.activeAbortController = abortController;
    this.interruptRequested = false;
    const isFirstTurn = this.turns.length === 0;

    try {
      const turn = await SessionProcessor.runTurn({
        abortSignal: abortController.signal,
        approvedCommandSignaturesOnce: this.consumeApprovedCommandSignaturesOnce(),
        approvedPermissionsOnce: this.consumeApprovedPermissionsOnce(),
        client: this.client,
        config: this.config,
        isFirstTurn: false,
        observer,
        sessionId: this.sessionId,
        task,
        userMessage: message,
      });

      const result = turn.result;
      if (isFirstTurn) {
        void scheduleSessionTitleFromFirstUserMessage({
          client: this.client,
          sessionId: this.sessionId,
          userMessage: message,
        });
      }
      this.turns.push({
        assistant: result.message,
        finalState: result.finalState,
        steps: result.context.steps.length,
        user: message,
      });

      await this.emitAssistantMessage(result.message, result.finalState);
      this.updateState({
        runState: result.finalState,
        turnCount: this.turns.length,
      });

      if (result.finalState === "waiting_for_user") {
        const refreshedSessionState = await loadSessionState(
          this.sessionId,
          this.config.pendingActionMaxAgeMs,
          this.config.approvalMemoryEnabled,
          this.config.interruptedRunRecoveryEnabled
        );

        this.pendingApproval = refreshedSessionState.pendingApproval;
        this.pendingPermission = await findOpenPendingPermission({
          maxAgeMs: this.config.pendingActionMaxAgeMs,
          sessionId: this.sessionId,
        });
        this.pendingFollowUpQuestion = refreshedSessionState.pendingFollowUpQuestion ?? result.message;

        this.updateState({
          hasPendingApproval: Boolean(this.pendingApproval),
          hasPendingPermission: Boolean(this.pendingPermission),
          runState: "waiting_for_user",
        });

        if (this.pendingApproval) {
          this.emitApprovalPrompt(this.pendingApproval);
        }
        if (this.pendingPermission) {
          this.emitPermissionPrompt(this.pendingPermission);
        }
      } else {
        this.pendingApproval = undefined;
        this.pendingPermission = null;
        this.pendingFollowUpQuestion = undefined;
        this.updateState({
          hasPendingApproval: false,
          hasPendingPermission: false,
        });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown runtime error";
      this.emitEvent({
        message: messageText,
        type: "error",
      });
      this.emitChatMessage("system", messageText);
      this.updateState({
        runState: "error",
      });
    } finally {
      this.activeAbortController = undefined;
      this.interruptRequested = false;
      this.updateState({
        activeToolName: undefined,
        isBusy: false,
        stepLabel: undefined,
      });
    }
  }

  private async resolveApprovalDecision(
    decision: ApprovalDecision,
    pendingApproval: OpenPendingApproval
  ): Promise<{ commandSignature?: string; contextNote: string; message: string }> {
    if (decision === "allow_once") {
      await resolvePendingApprovalAction({
        entry: pendingApproval.entry,
        sessionId: this.sessionId,
        updates: {
          decision: "allow",
          scope: "once",
        },
      });
      return {
        commandSignature: pendingApproval.context.commandSignature,
        contextNote:
          `Approval resolved by user: allow once.\n` +
          `Approved command: ${pendingApproval.context.command}\n` +
          `Reason: ${pendingApproval.context.reason}`,
        message: "Approval resolved: allow once.",
      };
    }

    if (decision === "deny") {
      await resolvePendingApprovalAction({
        entry: pendingApproval.entry,
        sessionId: this.sessionId,
        updates: {
          decision: "deny",
          scope: "once",
        },
      });
      return {
        contextNote:
          `Approval resolved by user: deny.\n` +
          `Denied command: ${pendingApproval.context.command}\n` +
          `Reason: ${pendingApproval.context.reason}`,
        message: "Approval resolved: deny.",
      };
    }

    const scope: ApprovalRuleScope =
      decision === "allow_always_workspace" ? "workspace" : "session";

    await storeApprovalRule({
      commandSignaturePattern: pendingApproval.context.commandSignature,
      config: this.config,
      decision: "allow",
      scope,
      sessionId: this.sessionId,
    });

    await appendSessionApprovalRule(this.sessionId, {
      decision: "allow",
      pattern: pendingApproval.context.commandSignature,
      scope,
    });

    await resolvePendingApprovalAction({
      entry: pendingApproval.entry,
      sessionId: this.sessionId,
      updates: {
        decision: "allow",
        scope,
      },
    });

    return {
      contextNote:
        `Approval resolved by user: always allow (${scope}).\n` +
        `Command signature: ${pendingApproval.context.commandSignature}`,
      message: `Approval resolved: always allow for this ${scope}.`,
    };
  }

  private async resolvePermissionDecision(
    reply: PermissionNext.Reply,
    pendingPermission: OpenPendingPermission
  ): Promise<{
    allowOnce: Array<{ pattern: string; permission: string }>;
    contextNote: string;
    message: string;
  }> {
    await resolvePendingPermissionAction({
      entry: pendingPermission.entry,
      reply,
      replyMessage: undefined,
      sessionId: this.sessionId,
    });

    const allowOnce =
      reply === "once"
        ? pendingPermission.context.patterns.map((pattern) => ({
            pattern,
            permission: pendingPermission.context.permission,
          }))
        : [];

    if (reply === "always") {
      for (const pattern of pendingPermission.context.always) {
        await storePermissionRule({
          action: "allow",
          config: this.config,
          pattern,
          permission: pendingPermission.context.permission,
          scope: "session",
          sessionId: this.sessionId,
        });
      }
    }

    return {
      allowOnce,
      contextNote:
        `Permission resolved by user: ${reply}.\n` +
        `Permission: ${pendingPermission.context.permission}\n` +
        `Patterns: ${pendingPermission.context.patterns.join(", ")}`,
      message: `Permission resolved: ${reply}.`,
    };
  }
}
