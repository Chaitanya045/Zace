from __future__ import annotations

from typing import Any, Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from .models import BridgeEvent, BridgeState
from .models import (
    ApprovalPromptEvent,
    ChatMessageEvent,
    ErrorEvent,
    PermissionPromptEvent,
    StateUpdateEvent,
    ToolStatusEvent,
)


class ZaceProtocolModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class InitialChatMessage(ZaceProtocolModel):
    finalState: str | None = None
    role: Literal["assistant", "system", "user"]
    text: str
    timestamp: int = Field(ge=0)


class InitResult(ZaceProtocolModel):
    messages: list[InitialChatMessage]
    state: BridgeState


class SubmitResult(ZaceProtocolModel):
    shouldExit: bool | None = None


class InterruptResult(ZaceProtocolModel):
    status: Literal["already_requested", "not_running", "requested"]


class SessionListItem(ZaceProtocolModel):
    firstUserMessage: str | None = None
    lastInteractedAgo: str = Field(min_length=1)
    lastInteractedAt: str = Field(min_length=1)
    sessionFilePath: str = Field(min_length=1)
    sessionId: str = Field(min_length=1)
    title: str = Field(min_length=1)


class ListSessionsResult(ZaceProtocolModel):
    sessions: list[SessionListItem]


class BridgeResponseSuccess(ZaceProtocolModel):
    id: str = Field(min_length=1)
    result: Any = None
    success: Literal[True] = True
    type: Literal["response"] = "response"


class BridgeResponseError(ZaceProtocolModel):
    error: str = Field(min_length=1)
    id: str = Field(min_length=1)
    success: Literal[False] = False
    type: Literal["response"] = "response"


BridgeResponse = Annotated[
    Union[BridgeResponseSuccess, BridgeResponseError],
    Field(discriminator="success"),
]


class BridgeEventEnvelope(ZaceProtocolModel):
    event: Annotated[
        Union[
            StateUpdateEvent,
            ChatMessageEvent,
            ToolStatusEvent,
            ApprovalPromptEvent,
            PermissionPromptEvent,
            ErrorEvent,
        ],
        Field(discriminator="type"),
    ]
    type: Literal["event"] = "event"


class BridgeCommandPayload(ZaceProtocolModel):
    command: Literal["exit", "help", "reset", "status"]
    kind: Literal["command"] = "command"


class BridgeTextPayload(ZaceProtocolModel):
    kind: Literal["message"] = "message"
    text: str


SubmitPayload = Annotated[Union[BridgeCommandPayload, BridgeTextPayload], Field(discriminator="kind")]


class BridgeInitRequestParams(ZaceProtocolModel):
    sessionFilePath: str = Field(min_length=1)
    sessionId: str = Field(min_length=1)
    uiConfig: dict[str, Any] | None = None


BridgeEventAdapter = TypeAdapter(
    Annotated[
        Union[
            StateUpdateEvent,
            ChatMessageEvent,
            ToolStatusEvent,
            ApprovalPromptEvent,
            PermissionPromptEvent,
            ErrorEvent,
        ],
        Field(discriminator="type"),
    ]
)
BridgeEventEnvelopeAdapter = TypeAdapter(BridgeEventEnvelope)
BridgeResponseAdapter = TypeAdapter(BridgeResponse)
InitResultAdapter = TypeAdapter(InitResult)
SubmitResultAdapter = TypeAdapter(SubmitResult)
InterruptResultAdapter = TypeAdapter(InterruptResult)
ListSessionsResultAdapter = TypeAdapter(ListSessionsResult)
BridgeInitRequestParamsAdapter = TypeAdapter(BridgeInitRequestParams)
SubmitPayloadAdapter = TypeAdapter(SubmitPayload)


def parse_bridge_event(payload: Any) -> BridgeEvent:
    return BridgeEventAdapter.validate_python(payload)


def parse_bridge_event_envelope(payload: Any) -> BridgeEventEnvelope:
    return BridgeEventEnvelopeAdapter.validate_python(payload)


def parse_bridge_response(payload: Any) -> BridgeResponseSuccess | BridgeResponseError:
    return BridgeResponseAdapter.validate_python(payload)


def parse_wire_message(payload: Any) -> BridgeEventEnvelope | BridgeResponseSuccess | BridgeResponseError:
    if not isinstance(payload, dict):
        raise TypeError("Bridge message payload must be a JSON object.")

    message_type = payload.get("type")
    if message_type == "event":
        return parse_bridge_event_envelope(payload)
    if message_type == "response":
        return parse_bridge_response(payload)

    raise ValueError("Unsupported bridge message type.")


def parse_init_result(payload: Any) -> InitResult:
    return InitResultAdapter.validate_python(payload)


def parse_submit_result(payload: Any) -> SubmitResult:
    return SubmitResultAdapter.validate_python(payload)


def parse_interrupt_result(payload: Any) -> InterruptResult:
    return InterruptResultAdapter.validate_python(payload)


def parse_list_sessions_result(payload: Any) -> ListSessionsResult:
    return ListSessionsResultAdapter.validate_python(payload)


def parse_init_request_params(payload: Any) -> BridgeInitRequestParams:
    return BridgeInitRequestParamsAdapter.validate_python(payload)


def parse_submit_payload(payload: Any) -> BridgeCommandPayload | BridgeTextPayload:
    return SubmitPayloadAdapter.validate_python(payload)


def format_validation_error(error: ValidationError | Exception) -> str:
    if isinstance(error, ValidationError):
        problems: list[str] = []
        for issue in error.errors():
            location = ".".join(str(part) for part in issue.get("loc", ()))
            message = str(issue.get("msg", "Invalid value"))
            problems.append(f"{location}: {message}" if location else message)
        if problems:
            return "; ".join(problems)
    return str(error)
