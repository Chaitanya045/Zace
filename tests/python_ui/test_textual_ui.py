from __future__ import annotations

from typing import Any

import pytest
from rich.align import Align
from textual import events
from textual.containers import Vertical
from textual.css.query import NoMatches
from textual.widgets import Input, RichLog, Static

from zace_tui.app import (
    BridgeEventMessage,
    ChatRichLog,
    RoundedGlassScrollBarRender,
    ZaceTextualApp,
)
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
        self.list_sessions_result: dict[str, Any] = {
            "sessions": [
                {
                    "lastInteractedAgo": "5m ago",
                    "lastInteractedAt": "2026-03-04T10:55:00.000Z",
                    "sessionFilePath": ".zace/sessions/test-session.jsonl",
                    "sessionId": "test-session",
                    "title": "Current Session",
                },
                {
                    "lastInteractedAgo": "1h ago",
                    "lastInteractedAt": "2026-03-04T10:00:00.000Z",
                    "sessionFilePath": ".zace/sessions/other-session.jsonl",
                    "sessionId": "other-session",
                    "title": "Other Session",
                },
            ]
        }
        self.switch_session_result: dict[str, Any] = {
            "messages": [
                {"role": "assistant", "text": "Loaded other session", "timestamp": 0},
            ],
            "state": {
                "hasPendingApproval": False,
                "hasPendingPermission": False,
                "isBusy": False,
                "runState": "idle",
                "sessionFilePath": ".zace/sessions/other-session.jsonl",
                "sessionId": "other-session",
                "turnCount": 1,
            },
        }
        self.new_session_result: dict[str, Any] = {
            "messages": [],
            "state": {
                "hasPendingApproval": False,
                "hasPendingPermission": False,
                "isBusy": False,
                "runState": "idle",
                "sessionFilePath": ".zace/sessions/chat-20260304-120000-abc123.jsonl",
                "sessionId": "chat-20260304-120000-abc123",
                "turnCount": 0,
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
        if method == "list_sessions":
            return self.list_sessions_result
        if method == "switch_session":
            return self.switch_session_result
        if method == "new_session":
            return self.new_session_result
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
async def test_smoke_boot_renders_without_session_bar() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        with pytest.raises(NoMatches):
            app.query_one("#session_bar", Static)
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
async def test_switch_session_palette_action_is_local_and_updates_session_state() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async def _select_other_session(_: Any) -> str:
        return "other-session"

    async with app.run_test() as pilot:
        await pilot.pause()
        app.push_screen_wait = _select_other_session  # type: ignore[assignment]
        await app._handle_palette_action("switch_session")
        await pilot.pause()

        assert ("list_sessions", {}) in fake_bridge.requests
        assert ("switch_session", {"sessionId": "other-session"}) in fake_bridge.requests
        assert ("submit", {"kind": "command", "command": "switch_session"}) not in fake_bridge.requests
        assert app._state.get("sessionId") == "other-session"
        assert app._chat_items[-1]["text"] == "Loaded other session"


@pytest.mark.asyncio
async def test_switch_session_is_blocked_while_busy() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        app._state["isBusy"] = True
        await app._handle_palette_action("switch_session")
        await pilot.pause()

        assert ("list_sessions", {}) not in fake_bridge.requests


@pytest.mark.asyncio
async def test_new_session_palette_action_is_local_and_resets_session_state() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        await app._handle_palette_action("new_session")
        await pilot.pause()

        assert ("new_session", {}) in fake_bridge.requests
        assert ("submit", {"kind": "command", "command": "new_session"}) not in fake_bridge.requests
        assert app._state.get("sessionId") == "chat-20260304-120000-abc123"
        assert app._chat_items == []
        assert app._show_welcome is True


@pytest.mark.asyncio
async def test_new_session_clears_composer_draft() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        composer = app.query_one("#composer", Input)
        composer.value = "draft text"

        await app._handle_palette_action("new_session")
        await pilot.pause()

        assert composer.value == ""


@pytest.mark.asyncio
async def test_new_session_is_blocked_while_busy() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        app._state["isBusy"] = True

        await app._handle_palette_action("new_session")
        await pilot.pause()

        assert ("new_session", {}) not in fake_bridge.requests


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

        assert app._active_theme == "pastel"
        assert app.screen.has_class("theme-pastel")


@pytest.mark.asyncio
async def test_theme_palette_action_is_local() -> None:
    fake_bridge = FakeBridge()
    app = build_app(fake_bridge)

    async with app.run_test() as pilot:
        await pilot.pause()
        await app._handle_palette_action("theme_ocean")
        await pilot.pause()

        assert app._active_theme == "ocean"
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
async def test_chat_messages_use_symmetric_edge_padding_on_wide_viewport() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test(size=(160, 24)) as pilot:
        await pilot.pause()
        app._append_chat("assistant", "hi")
        app._append_chat("user", "hello")
        await pilot.pause()

        log = app.query_one("#chat_log", RichLog)
        assert log.scrollable_content_region.width > 78
        assert len(log.lines) == 3
        assistant_line = log.lines[0].text
        user_line = log.lines[2].text

        assistant_left_inset = len(assistant_line) - len(assistant_line.lstrip(" "))
        user_right_inset = len(user_line) - len(user_line.rstrip(" "))

        assert assistant_left_inset == app.CHAT_EDGE_PADDING
        assert user_right_inset == app.CHAT_EDGE_PADDING


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


@pytest.mark.asyncio
async def test_chat_scrollbar_is_thin_and_visible_only_during_scroll_activity() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test(size=(120, 24)) as pilot:
        await pilot.pause()
        app._append_chat("assistant", "line 1")
        await pilot.pause()

        log = app.query_one("#chat_log", RichLog)
        assert log.styles.scrollbar_size_vertical == 1
        assert not log.has_class("scroll-active")

        app._reveal_chat_scrollbar()
        assert log.has_class("scroll-active")

        await pilot.pause(app.CHAT_SCROLLBAR_HIDE_DELAY_SECONDS + 0.2)
        assert not log.has_class("scroll-active")


@pytest.mark.asyncio
async def test_chat_scrollbar_hide_timer_is_reset_on_continued_scrolling() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test(size=(120, 24)) as pilot:
        await pilot.pause()
        app._append_chat("assistant", "line 1")
        await pilot.pause()

        log = app.query_one("#chat_log", RichLog)
        app._reveal_chat_scrollbar()
        await pilot.pause(app.CHAT_SCROLLBAR_HIDE_DELAY_SECONDS / 2)
        app._reveal_chat_scrollbar()
        await pilot.pause(app.CHAT_SCROLLBAR_HIDE_DELAY_SECONDS / 2)

        assert log.has_class("scroll-active")

        await pilot.pause(app.CHAT_SCROLLBAR_HIDE_DELAY_SECONDS + 0.2)
        await pilot.pause()

        assert not log.has_class("scroll-active")


@pytest.mark.asyncio
async def test_mouse_scroll_inside_chat_reveals_scrollbar_when_not_at_edges() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test(size=(120, 24)) as pilot:
        await pilot.pause()
        for index in range(50):
            app._append_chat("assistant", f"line {index}")
        await pilot.pause()

        log = app.query_one("#chat_log", ChatRichLog)
        assert log.max_scroll_y > 0
        log.scroll_end(animate=False, immediate=True)
        await pilot.pause()
        assert log.is_vertical_scroll_end
        assert not log.has_class("scroll-active")

        log._on_mouse_scroll_up(
            events.MouseScrollUp(
                widget=log,
                x=0,
                y=0,
                delta_x=0,
                delta_y=0,
                button=0,
                shift=False,
                meta=False,
                ctrl=False,
            )
        )
        assert log.has_class("scroll-active")


@pytest.mark.asyncio
async def test_chat_scrollbar_uses_rounded_glass_renderer() -> None:
    fake_bridge = FakeBridge()
    fake_bridge.init_result["messages"] = []
    fake_bridge.init_result["state"]["turnCount"] = 0
    app = build_app(fake_bridge)

    async with app.run_test(size=(120, 24)) as pilot:
        await pilot.pause()
        for index in range(40):
            app._append_chat("assistant", f"line {index}")
        await pilot.pause()

        log = app.query_one("#chat_log", ChatRichLog)
        log.scroll_end(animate=False, immediate=True)
        await pilot.pause()
        log._refresh_scrollbars()

        assert log.vertical_scrollbar.renderer is RoundedGlassScrollBarRender
