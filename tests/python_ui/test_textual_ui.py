from __future__ import annotations

from typing import Any

import pytest
from textual.widgets import Static

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
