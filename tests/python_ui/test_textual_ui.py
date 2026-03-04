from __future__ import annotations

from typing import Any

import pytest
from rich.align import Align
from textual.containers import Vertical
from textual.widgets import RichLog, Static

from zace_tui.app import BridgeEventMessage, ZaceTextualApp
from zace_tui.models import BridgeInitPayload


class FakeBridge:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.started = False
        self.stopped = False
        self.init_result: dict[str, Any] = {
            "messages": [
                {"role": "assistant", "text": "Welcome to Zace", "timestamp": 0},
            ],
            "state": {
                "hasPendingApproval": False,
                "hasPendingPermission": False,
                "isBusy": False,
                "runState": "idle",
                "sessionFilePath": ".zace/sessions/test.jsonl",
                "sessionId": "test-session",
                "turnCount": 1,
            },
        }

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.requests.append((method, params))
        if method == "init":
            return self.init_result
        if method == "interrupt":
            return {"status": "not_running"}
        return {}


def build_app(fake_bridge: FakeBridge) -> ZaceTextualApp:
    return ZaceTextualApp(
        bridge_client=fake_bridge,
        bridge_command=["bun", "run", "src/ui/bridge/entry.ts"],
        bridge_env={},
        payload=BridgeInitPayload(
            session_file_path=".zace/sessions/test.jsonl",
            session_id="test-session",
            ui_config={},
        ),
        workdir=".",
    )


@pytest.mark.asyncio
async def test_smoke_boot_renders_session_bar() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        session_bar = app.query_one("#session_bar", Static)
        assert "session: test-session" in str(session_bar.renderable)
        assert "theme: zace" in str(session_bar.renderable)
        assert app.screen.has_class("theme-zace")
        welcome_screen = app.query_one("#welcome_screen", Vertical)
        chat_log = app.query_one("#chat_log", RichLog)
        assert welcome_screen.display is False
        assert chat_log.display is True
        assert fake_bridge.started is True


@pytest.mark.asyncio
async def test_command_palette_submits_status_command() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("ctrl+p")
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()

        assert ("submit", {"kind": "command", "command": "status"}) in fake_bridge.requests


@pytest.mark.asyncio
async def test_approval_modal_replies_once() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        app.post_message(
            BridgeEventMessage(
                {
                    "command": "rm -rf /tmp/demo",
                    "options": [
                        {"id": "allow_once", "label": "Allow once"},
                        {"id": "deny", "label": "Deny"},
                    ],
                    "prompt": "Approval required",
                    "reason": "Destructive command",
                    "type": "approval_prompt",
                }
            )
        )
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()

        assert ("approval_reply", {"decision": "allow_once"}) in fake_bridge.requests


@pytest.mark.asyncio
async def test_tool_status_strip_updates() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()

        app.post_message(
            BridgeEventMessage(
                {
                    "attempt": 1,
                    "status": "started",
                    "step": 1,
                    "toolName": "execute_command",
                    "type": "tool_status",
                }
            )
        )
        await pilot.pause()

        tool_strip = app.query_one("#tool_strip", Static)
        assert "execute_command" in str(tool_strip.renderable)

        app.post_message(
            BridgeEventMessage(
                {
                    "attempt": 1,
                    "status": "finished",
                    "step": 1,
                    "success": True,
                    "toolName": "execute_command",
                    "type": "tool_status",
                }
            )
        )
        await pilot.pause()

        assert "active tool: idle" in str(tool_strip.renderable)


@pytest.mark.asyncio
async def test_thinking_strip_updates() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()

        app.post_message(
            BridgeEventMessage(
                {
                    "state": {
                        "activeToolName": "",
                        "isBusy": True,
                    },
                    "type": "state_update",
                }
            )
        )
        await pilot.pause()

        tool_strip = app.query_one("#tool_strip", Static)
        assert "thinking" in str(tool_strip.renderable)


@pytest.mark.asyncio
async def test_cycle_theme_shortcut_updates_theme() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("ctrl+t")
        await pilot.pause()

        session_bar = app.query_one("#session_bar", Static)
        assert "theme: pastel" in str(session_bar.renderable)
        assert app.screen.has_class("theme-pastel")


@pytest.mark.asyncio
async def test_theme_palette_action_is_local() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        await app._handle_palette_action("theme_ocean")
        await pilot.pause()

        session_bar = app.query_one("#session_bar", Static)
        assert "theme: ocean" in str(session_bar.renderable)
        assert app.screen.has_class("theme-ocean")
        assert ("submit", {"kind": "command", "command": "theme_ocean"}) not in fake_bridge.requests


def test_render_helpers_do_not_raise_before_mount() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    app._render_state()
    app._render_layout_state()
    app._render_activity_strip()
    app._append_chat("assistant", "safe before mount")


def test_chat_line_alignment_is_role_based() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    user_line = app._build_chat_line("user", "hello", None)
    assistant_line = app._build_chat_line("assistant", "hi", None)

    assert isinstance(user_line, Align)
    assert isinstance(assistant_line, Align)
    assert user_line.align == "right"
    assert assistant_line.align == "left"


@pytest.mark.asyncio
async def test_welcome_hides_after_submit() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("h", "i", "enter")
        await pilot.pause()

        welcome_screen = app.query_one("#welcome_screen", Vertical)
        chat_log = app.query_one("#chat_log", RichLog)
        assert welcome_screen.display is False
        assert chat_log.display is True


@pytest.mark.asyncio
async def test_welcome_shows_when_session_is_empty() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()

        welcome_screen = app.query_one("#welcome_screen", Vertical)
        chat_log = app.query_one("#chat_log", RichLog)
        assert welcome_screen.display is True
        assert chat_log.display is False


@pytest.mark.asyncio
async def test_streaming_chat_chunks_merge_into_single_message() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()

        app.post_message(
            BridgeEventMessage(
                {
                    "chunk": "start",
                    "role": "assistant",
                    "streamId": "assistant-1",
                    "text": "",
                    "timestamp": 1,
                    "type": "chat_message",
                }
            )
        )
        app.post_message(
            BridgeEventMessage(
                {
                    "chunk": "delta",
                    "role": "assistant",
                    "streamId": "assistant-1",
                    "text": "Hello ",
                    "timestamp": 2,
                    "type": "chat_message",
                }
            )
        )
        app.post_message(
            BridgeEventMessage(
                {
                    "chunk": "delta",
                    "role": "assistant",
                    "streamId": "assistant-1",
                    "text": "world",
                    "timestamp": 3,
                    "type": "chat_message",
                }
            )
        )
        app.post_message(
            BridgeEventMessage(
                {
                    "chunk": "end",
                    "finalState": "completed",
                    "role": "assistant",
                    "streamId": "assistant-1",
                    "text": "",
                    "timestamp": 4,
                    "type": "chat_message",
                }
            )
        )
        await pilot.pause()

        assert len(app._chat_items) == 1
        assert app._chat_items[0]["text"] == "Hello world"
        assert app._chat_items[0]["final_state"] == "completed"


@pytest.mark.asyncio
async def test_user_messages_render_at_chat_log_right_edge_on_wide_viewport() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test(size=(160, 24)) as pilot:
        await pilot.pause()
        app._append_chat("user", "hello")
        await pilot.pause()

        log = app.query_one("#chat_log", RichLog)
        assert log.scrollable_content_region.width > 78
        assert len(log.lines) == 1
        assert log.lines[0].cell_length == log.scrollable_content_region.width
        assert log.lines[0].text.rstrip().endswith("you: hello")


@pytest.mark.asyncio
async def test_chat_messages_have_blank_separator_line() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test(size=(120, 24)) as pilot:
        await pilot.pause()
        app._append_chat("assistant", "first")
        app._append_chat("user", "second")
        await pilot.pause()

        log = app.query_one("#chat_log", RichLog)
        assert len(log.lines) == 3
        assert log.lines[1].text.strip() == ""
