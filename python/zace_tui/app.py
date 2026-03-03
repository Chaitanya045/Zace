from __future__ import annotations

import asyncio
from typing import Any, Optional

from rich.markup import escape
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.message import Message
from textual.screen import ModalScreen
from textual.widgets import Footer, Header, Input, OptionList, RichLog, Static
from textual.widgets.option_list import Option

from .bridge_client import BridgeError, JsonRpcBridgeClient
from .models import BridgeInitPayload, BridgePromptOption, BridgeState


class BridgeEventMessage(Message):
    def __init__(self, event: dict[str, Any]) -> None:
        super().__init__()
        self.event = event


class ChoiceModal(ModalScreen[Optional[str]]):
    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, title: str, message: str, options: list[BridgePromptOption]) -> None:
        super().__init__()
        self._title = title
        self._message = message
        self._options = options

    def compose(self) -> ComposeResult:
        yield Vertical(
            Static(self._title, id="modal_title"),
            Static(self._message, id="modal_message"),
            OptionList(*[Option(option["label"], id=option["id"]) for option in self._options], id="modal_options"),
            id="modal_container",
        )

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        selected = event.option.id
        if isinstance(selected, str):
            self.dismiss(selected)
            return
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class HelpModal(ModalScreen[None]):
    BINDINGS = [
        Binding("enter", "close", "Close"),
        Binding("escape", "close", "Close"),
    ]

    HELP_TEXT = "\n".join(
        [
            "Shortcuts",
            "- Enter: submit message",
            "- Ctrl+P: command palette",
            "- Ctrl+C: interrupt active run / exit",
            "- F1 or ?: help",
        ]
    )

    def compose(self) -> ComposeResult:
        yield Vertical(
            Static("Help", id="modal_title"),
            Static(self.HELP_TEXT, id="modal_message"),
            id="modal_container",
        )

    def action_close(self) -> None:
        self.dismiss(None)


class ZaceTextualApp(App[None]):
    CSS_PATH = "theme.tcss"
    TITLE = "Zace"
    SUB_TITLE = "Textual"

    BINDINGS = [
        Binding("ctrl+p", "open_palette", "Palette"),
        Binding("ctrl+c", "interrupt_or_exit", "Interrupt/Exit"),
        Binding("f1", "show_help", "Help"),
        Binding("question_mark", "show_help", "Help"),
    ]

    COMMANDS: list[BridgePromptOption] = [
        {"id": "status", "label": "Show status"},
        {"id": "reset", "label": "Reset in-memory context"},
        {"id": "help", "label": "Show keyboard help"},
        {"id": "exit", "label": "Exit"},
    ]

    def __init__(
        self,
        bridge_command: list[str],
        bridge_env: dict[str, str],
        payload: BridgeInitPayload,
        workdir: str,
        bridge_client: JsonRpcBridgeClient | None = None,
    ) -> None:
        super().__init__()
        self._payload = payload
        self._bridge = bridge_client or JsonRpcBridgeClient(
            command=bridge_command,
            cwd=workdir,
            env=bridge_env,
            on_event=self._queue_bridge_event,
        )
        self._state: BridgeState = {
            "activeToolName": "",
            "hasPendingApproval": False,
            "hasPendingPermission": False,
            "isBusy": False,
            "runState": "idle",
            "sessionFilePath": payload.session_file_path,
            "sessionId": payload.session_id,
            "stepLabel": "",
            "turnCount": 0,
        }
        self._interrupt_armed = False
        self._modal_lock = asyncio.Lock()

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        yield Static(id="session_bar")
        yield RichLog(id="chat_log", auto_scroll=True, markup=True, highlight=False, wrap=True)
        yield Static(id="tool_strip")
        yield Input(placeholder="Type your message and press Enter", id="composer")
        yield Footer()

    async def on_mount(self) -> None:
        self.query_one("#composer", Input).focus()
        await self._bridge.start()

        try:
            init_result = await self._bridge.request(
                "init",
                {
                    "sessionFilePath": self._payload.session_file_path,
                    "sessionId": self._payload.session_id,
                    "uiConfig": self._payload.ui_config,
                },
            )
        except BridgeError as error:
            self._append_chat("system", f"Bridge init failed: {error}")
            self.exit(1)
            return

        state = init_result.get("state")
        if isinstance(state, dict):
            self._state.update(state)

        messages = init_result.get("messages")
        if isinstance(messages, list):
            for message in messages:
                if not isinstance(message, dict):
                    continue
                role = str(message.get("role", "assistant"))
                text = str(message.get("text", ""))
                final_state_raw = message.get("finalState")
                final_state = str(final_state_raw) if isinstance(final_state_raw, str) else None
                self._append_chat(role, text, final_state)

        self._render_state()

    async def on_unmount(self) -> None:
        await self._bridge.stop()

    async def _queue_bridge_event(self, event: dict[str, Any]) -> None:
        self.post_message(BridgeEventMessage(event))

    async def on_bridge_event_message(self, message: BridgeEventMessage) -> None:
        event = message.event
        event_type = event.get("type")

        if event_type == "state_update":
            state = event.get("state")
            if isinstance(state, dict):
                self._state.update(state)
                if not bool(self._state.get("isBusy", False)):
                    self._interrupt_armed = False
                self._render_state()
            return

        if event_type == "chat_message":
            role = str(event.get("role", "assistant"))
            text = str(event.get("text", ""))
            final_state_raw = event.get("finalState")
            final_state = str(final_state_raw) if isinstance(final_state_raw, str) else None
            self._append_chat(role, text, final_state)
            return

        if event_type == "tool_status":
            status = str(event.get("status", ""))
            if status == "started":
                self._state["activeToolName"] = str(event.get("toolName", ""))
            elif status == "finished":
                self._state["activeToolName"] = ""
            self._render_state()
            return

        if event_type == "approval_prompt":
            self.run_worker(self._show_approval_prompt(event), group="bridge_modal", exclusive=True)
            return

        if event_type == "permission_prompt":
            self.run_worker(self._show_permission_prompt(event), group="bridge_modal", exclusive=True)
            return

        if event_type == "error":
            text = str(event.get("message", "Unknown bridge error."))
            self._append_chat("system", text)
            self.notify(text, severity="warning")
            return

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "composer":
            return

        raw_text = event.value
        text = raw_text.strip()
        event.input.value = ""
        if not text:
            return

        self.run_worker(
            self._submit_payload(
                {
                    "kind": "message",
                    "text": text,
                }
            ),
            group="submit",
            exclusive=True,
        )

    async def action_open_palette(self) -> None:
        choice = await self.push_screen_wait(
            ChoiceModal(
                title="Command Palette",
                message="Select an action",
                options=self.COMMANDS,
            )
        )
        if not isinstance(choice, str):
            return

        self.run_worker(
            self._submit_payload(
                {
                    "kind": "command",
                    "command": choice,
                }
            ),
            group="submit",
            exclusive=True,
        )

    async def action_show_help(self) -> None:
        await self.push_screen_wait(HelpModal())

    async def action_interrupt_or_exit(self) -> None:
        if bool(self._state.get("isBusy", False)):
            try:
                result = await self._bridge.request("interrupt", {})
            except BridgeError as error:
                self._append_chat("system", f"Interrupt failed: {error}")
                await self.action_exit_app()
                return

            status = str(result.get("status", ""))
            if status == "requested":
                self._interrupt_armed = True
                self.notify("Interrupt requested", severity="information")
                return

            if status == "already_requested" and self._interrupt_armed:
                await self.action_exit_app()
                return

            if status == "already_requested":
                self._interrupt_armed = True
                self.notify("Interrupt already requested. Press Ctrl+C again to force exit.", severity="warning")
                return

        await self.action_exit_app()

    async def action_exit_app(self) -> None:
        await self._bridge.stop()
        self.exit()

    async def _submit_payload(self, payload: dict[str, Any]) -> None:
        try:
            result = await self._bridge.request("submit", payload)
        except BridgeError as error:
            self._append_chat("system", f"Submit failed: {error}")
            return

        if bool(result.get("shouldExit", False)):
            await self.action_exit_app()

    async def _show_approval_prompt(self, event: dict[str, Any]) -> None:
        async with self._modal_lock:
            options = event.get("options")
            if not isinstance(options, list):
                return

            prompt = str(event.get("prompt", "Approval required"))
            command = str(event.get("command", ""))
            reason = str(event.get("reason", ""))
            message = f"{prompt}\n\nCommand:\n{command}\n\nReason: {reason}"
            choice = await self.push_screen_wait(
                ChoiceModal(
                    title="Approval Required",
                    message=message,
                    options=[
                        option
                        for option in options
                        if isinstance(option, dict)
                        and isinstance(option.get("id"), str)
                        and isinstance(option.get("label"), str)
                    ],
                )
            )
            if not isinstance(choice, str):
                return

            try:
                await self._bridge.request(
                    "approval_reply",
                    {
                        "decision": choice,
                    },
                )
            except BridgeError as error:
                self._append_chat("system", f"Approval reply failed: {error}")

    async def _show_permission_prompt(self, event: dict[str, Any]) -> None:
        async with self._modal_lock:
            options = event.get("options")
            if not isinstance(options, list):
                return

            prompt = str(event.get("prompt", "Permission required"))
            permission = str(event.get("permission", ""))
            patterns_raw = event.get("patterns")
            patterns = patterns_raw if isinstance(patterns_raw, list) else []
            pattern_text = ", ".join(str(pattern) for pattern in patterns)
            message = f"{prompt}\n\nPermission: {permission}\nPatterns: {pattern_text}"
            choice = await self.push_screen_wait(
                ChoiceModal(
                    title="Permission Required",
                    message=message,
                    options=[
                        option
                        for option in options
                        if isinstance(option, dict)
                        and isinstance(option.get("id"), str)
                        and isinstance(option.get("label"), str)
                    ],
                )
            )
            if not isinstance(choice, str):
                return

            try:
                await self._bridge.request(
                    "permission_reply",
                    {
                        "reply": choice,
                    },
                )
            except BridgeError as error:
                self._append_chat("system", f"Permission reply failed: {error}")

    def _render_state(self) -> None:
        session_bar = self.query_one("#session_bar", Static)
        tool_strip = self.query_one("#tool_strip", Static)

        pending_approval = "pending" if bool(self._state.get("hasPendingApproval", False)) else "none"
        pending_permission = "pending" if bool(self._state.get("hasPendingPermission", False)) else "none"
        step_label = str(self._state.get("stepLabel", "step:n/a") or "step:n/a")

        session_bar.update(
            " | ".join(
                [
                    f"session: {self._state.get('sessionId', '')}",
                    f"turns: {self._state.get('turnCount', 0)}",
                    f"state: {self._state.get('runState', 'idle')}",
                    step_label,
                    f"approval: {pending_approval}",
                    f"permission: {pending_permission}",
                ]
            )
        )

        active_tool = str(self._state.get("activeToolName", "") or "")
        if active_tool:
            tool_strip.update(f"active tool: {active_tool}")
            return

        tool_strip.update("active tool: idle")

    def _append_chat(self, role: str, text: str, final_state: str | None = None) -> None:
        log = self.query_one("#chat_log", RichLog)

        safe_text = escape(text)
        if role == "user":
            prefix = "[#6C7AA8]you[/]"
        elif role == "assistant":
            prefix = "[#6FA38C]agent[/]"
        else:
            prefix = "[#A68A7B]system[/]"

        suffix = f" [#9CA3AF]({escape(final_state)})[/]" if final_state else ""
        log.write(f"{prefix}: {safe_text}{suffix}")
