from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, TypedDict, Union


class BridgePromptOption(TypedDict):
    id: str
    label: str


class BridgeState(TypedDict, total=False):
    activeToolName: str
    hasPendingApproval: bool
    hasPendingPermission: bool
    isBusy: bool
    runState: str
    sessionFilePath: str
    sessionId: str
    stepLabel: str
    turnCount: int


class ChatMessageEvent(TypedDict, total=False):
    chunk: Literal["delta", "end", "start"]
    finalState: str
    role: Literal["assistant", "system", "user"]
    streamId: str
    text: str
    timestamp: int
    type: Literal["chat_message"]


class StateUpdateEvent(TypedDict):
    state: BridgeState
    type: Literal["state_update"]


class ToolStatusEvent(TypedDict, total=False):
    attempt: int
    status: Literal["finished", "started"]
    step: int
    success: bool
    toolName: str
    type: Literal["tool_status"]


class ApprovalPromptEvent(TypedDict):
    command: str
    options: list[BridgePromptOption]
    prompt: str
    reason: str
    type: Literal["approval_prompt"]


class PermissionPromptEvent(TypedDict):
    options: list[BridgePromptOption]
    patterns: list[str]
    permission: str
    prompt: str
    type: Literal["permission_prompt"]


class ErrorEvent(TypedDict):
    message: str
    type: Literal["error"]


BridgeEvent = Union[
    ApprovalPromptEvent,
    ChatMessageEvent,
    ErrorEvent,
    PermissionPromptEvent,
    StateUpdateEvent,
    ToolStatusEvent,
]


@dataclass
class BridgeInitPayload:
    session_file_path: str
    session_id: str
    ui_config: dict[str, Any]
