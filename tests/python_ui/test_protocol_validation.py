from __future__ import annotations

import pytest
from pydantic import ValidationError

from zace_tui.models import ChatMessageEvent
from zace_tui.protocol import (
    BridgeResponseError,
    BridgeResponseSuccess,
    parse_list_sessions_result,
    parse_bridge_event,
    parse_bridge_response,
    parse_wire_message,
)


def test_parse_bridge_event_accepts_valid_chat_message() -> None:
    payload = {
        "role": "assistant",
        "text": "hello",
        "timestamp": 1,
        "type": "chat_message",
    }

    event = parse_bridge_event(payload)

    assert isinstance(event, ChatMessageEvent)
    assert event.text == "hello"


def test_parse_bridge_event_rejects_invalid_type() -> None:
    payload = {
        "role": "assistant",
        "text": "hello",
        "timestamp": 1,
        "type": "unknown_event",
    }

    with pytest.raises(ValidationError):
        parse_bridge_event(payload)


def test_parse_bridge_event_rejects_missing_required_fields() -> None:
    payload = {
        "role": "assistant",
        "timestamp": 1,
        "type": "chat_message",
    }

    with pytest.raises(ValidationError):
        parse_bridge_event(payload)


def test_parse_bridge_response_success_and_error_variants() -> None:
    success_payload = {
        "id": "1",
        "result": {"ok": True},
        "success": True,
        "type": "response",
    }
    error_payload = {
        "error": "bad request",
        "id": "2",
        "success": False,
        "type": "response",
    }

    success = parse_bridge_response(success_payload)
    error = parse_bridge_response(error_payload)

    assert isinstance(success, BridgeResponseSuccess)
    assert isinstance(error, BridgeResponseError)
    assert success.result == {"ok": True}
    assert error.error == "bad request"


def test_parse_wire_message_dispatches_event_and_response() -> None:
    event_payload = {
        "event": {
            "role": "assistant",
            "text": "hello",
            "timestamp": 1,
            "type": "chat_message",
        },
        "type": "event",
    }
    response_payload = {
        "id": "1",
        "result": {"ok": True},
        "success": True,
        "type": "response",
    }

    parsed_event = parse_wire_message(event_payload)
    parsed_response = parse_wire_message(response_payload)

    assert getattr(parsed_event, "type", None) == "event"
    assert isinstance(parsed_response, BridgeResponseSuccess)


def test_parse_list_sessions_result_accepts_valid_payload() -> None:
    payload = {
        "sessions": [
            {
                "lastInteractedAgo": "1h ago",
                "lastInteractedAt": "2026-03-04T10:00:00.000Z",
                "sessionFilePath": ".zace/sessions/chat-1.jsonl",
                "sessionId": "chat-1",
                "title": "Fix failing tests",
            }
        ]
    }

    result = parse_list_sessions_result(payload)

    assert len(result.sessions) == 1
    assert result.sessions[0].sessionId == "chat-1"


def test_parse_list_sessions_result_rejects_missing_required_field() -> None:
    payload = {
        "sessions": [
            {
                "lastInteractedAgo": "1h ago",
                "lastInteractedAt": "2026-03-04T10:00:00.000Z",
                "sessionId": "chat-1",
                "title": "Fix failing tests",
            }
        ]
    }

    with pytest.raises(ValidationError):
        parse_list_sessions_result(payload)
