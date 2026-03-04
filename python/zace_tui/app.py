from __future__ import annotations

import asyncio
from typing import Any, Optional

from rich.align import Align
from rich.padding import Padding
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.css.query import NoMatches
from textual.message import Message
from textual.screen import ModalScreen
from textual.timer import Timer
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

    def on_mount(self) -> None:
        self.query_one("#modal_options", OptionList).focus()

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
            "- Ctrl+T: cycle theme",
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
    THEME_ORDER = ("zace", "pastel", "ocean")

    BINDINGS = [
        Binding("ctrl+p", "open_palette", "Palette", priority=True),
        Binding("ctrl+t", "cycle_theme", "Theme", priority=True),
        Binding("ctrl+c", "interrupt_or_exit", "Interrupt/Exit", priority=True),
        Binding("f1", "show_help", "Help"),
        Binding("question_mark", "show_help", "Help"),
    ]

    PALETTE_ACTIONS: list[BridgePromptOption] = [
        {"id": "status", "label": "Show status"},
        {"id": "reset", "label": "Reset in-memory context"},
        {"id": "help", "label": "Show keyboard help"},
        {"id": "theme_cycle", "label": "Cycle theme"},
        {"id": "theme_zace", "label": "Theme: zace (high contrast)"},
        {"id": "theme_pastel", "label": "Theme: pastel"},
        {"id": "theme_ocean", "label": "Theme: ocean"},
        {"id": "exit", "label": "Exit"},
    ]
    START_META = 'Build GPT-5.2 GitHub Copilot · xhigh'
    START_PLACEHOLDER = 'Ask anything... "Fix broken tests"'
    START_SHORTCUTS = "ctrl+t variants   tab agents   ctrl+p commands"
    START_TIP = "Tip  Use /theme or Ctrl+T to switch themes"
    CHAT_EDGE_PADDING = 2

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
        self._dot_phase = 0
        self._activity_timer: Optional[Timer] = None
        self._active_theme = self._resolve_initial_theme(payload.ui_config)
        self._show_welcome = True
        self._chat_items: list[dict[str, Optional[str]]] = []
        self._chat_stream_index_by_id: dict[str, int] = {}

    def compose(self) -> ComposeResult:
        yield Static(id="top_glow")
        yield Static(id="session_bar")
        yield Vertical(
            Vertical(
                Static("zace", id="welcome_logo"),
                Vertical(
                    Static(self.START_PLACEHOLDER, id="welcome_placeholder"),
                    Static(self.START_META, id="welcome_meta"),
                    id="welcome_input_card",
                ),
                Static(self.START_SHORTCUTS, id="welcome_shortcuts"),
                Static(self.START_TIP, id="welcome_tip"),
                id="welcome_content",
            ),
            id="welcome_screen",
        )
        yield RichLog(id="chat_log", auto_scroll=True, markup=True, highlight=False, wrap=True)
        yield Static(id="tool_strip")
        yield Input(placeholder="Type your message and press Enter", id="composer")
        yield Footer()

    async def on_mount(self) -> None:
        self._apply_theme(self._active_theme)
        self.query_one("#composer", Input).focus()
        self._activity_timer = self.set_interval(0.35, self._advance_activity_animation)
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

        has_messages = False
        messages = init_result.get("messages")
        if isinstance(messages, list):
            for message in messages:
                if not isinstance(message, dict):
                    continue
                has_messages = True
                role = str(message.get("role", "assistant"))
                text = str(message.get("text", ""))
                final_state_raw = message.get("finalState")
                final_state = str(final_state_raw) if isinstance(final_state_raw, str) else None
                self._append_chat(role, text, final_state)

        if has_messages or int(self._state.get("turnCount", 0)) > 0:
            self._show_welcome = False

        self._render_layout_state()
        self._render_state()

    async def on_unmount(self) -> None:
        if self._activity_timer is not None:
            self._activity_timer.stop()
            self._activity_timer = None
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
                    self._dot_phase = 0
                self._render_state()
            return

        if event_type == "chat_message":
            role = str(event.get("role", "assistant"))
            text = str(event.get("text", ""))
            final_state_raw = event.get("finalState")
            final_state = str(final_state_raw) if isinstance(final_state_raw, str) else None
            stream_id_raw = event.get("streamId")
            stream_id = str(stream_id_raw) if isinstance(stream_id_raw, str) else None
            chunk_raw = event.get("chunk")
            chunk = str(chunk_raw) if isinstance(chunk_raw, str) else None

            if stream_id and chunk in {"start", "delta", "end"}:
                self._handle_streaming_chat_event(role, text, final_state, stream_id, chunk)
                return

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

        if self._show_welcome:
            self._show_welcome = False
            self._render_layout_state()

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
        self.run_worker(self._open_palette_flow(), group="palette", exclusive=True)

    async def _open_palette_flow(self) -> None:
        modal = ChoiceModal(
            title="Command Palette",
            message="Select an action",
            options=self.PALETTE_ACTIONS,
        )
        self._apply_theme_to_node(modal)
        choice = await self.push_screen_wait(modal)
        if not isinstance(choice, str):
            return

        await self._handle_palette_action(choice)

    async def action_cycle_theme(self) -> None:
        next_index = (self.THEME_ORDER.index(self._active_theme) + 1) % len(self.THEME_ORDER)
        next_theme = self.THEME_ORDER[next_index]
        self._apply_theme(next_theme)
        self.notify(f"Theme: {next_theme}", severity="information")

    async def action_show_help(self) -> None:
        self.run_worker(self._show_help_modal(), group="help_modal", exclusive=True)

    async def _show_help_modal(self) -> None:
        modal = HelpModal()
        self._apply_theme_to_node(modal)
        await self.push_screen_wait(modal)

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
        if self._activity_timer is not None:
            self._activity_timer.stop()
            self._activity_timer = None
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
            modal = ChoiceModal(
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
            self._apply_theme_to_node(modal)
            choice = await self.push_screen_wait(modal)
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
            modal = ChoiceModal(
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
            self._apply_theme_to_node(modal)
            choice = await self.push_screen_wait(modal)
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
        try:
            session_bar = self.query_one("#session_bar", Static)
        except NoMatches:
            return

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
                    f"theme: {self._active_theme}",
                    f"approval: {pending_approval}",
                    f"permission: {pending_permission}",
                ]
            )
        )
        self._render_activity_strip()

    def _render_layout_state(self) -> None:
        try:
            welcome_screen = self.query_one("#welcome_screen", Vertical)
            chat_log = self.query_one("#chat_log", RichLog)
        except NoMatches:
            return

        welcome_screen.display = self._show_welcome
        chat_log.display = not self._show_welcome

    async def _handle_palette_action(self, choice: str) -> None:
        if choice == "theme_cycle":
            await self.action_cycle_theme()
            return

        if choice.startswith("theme_"):
            theme_name = choice.removeprefix("theme_")
            self._apply_theme(theme_name)
            self.notify(f"Theme: {theme_name}", severity="information")
            return

        await self._submit_payload(
            {
                "kind": "command",
                "command": choice,
            }
        )

    def _resolve_initial_theme(self, ui_config: dict[str, Any]) -> str:
        raw_theme = ui_config.get("theme")
        if isinstance(raw_theme, str):
            normalized = raw_theme.strip().lower()
            if normalized in self.THEME_ORDER:
                return normalized
        return "zace"

    def _apply_theme(self, theme_name: str) -> None:
        if theme_name not in self.THEME_ORDER:
            return
        if theme_name == self._active_theme and self.has_class(f"theme-{theme_name}"):
            return

        for candidate in self.THEME_ORDER:
            css_class = f"theme-{candidate}"
            self.remove_class(css_class)
            self.screen.remove_class(css_class)

        current_css_class = f"theme-{theme_name}"
        self.add_class(current_css_class)
        self.screen.add_class(current_css_class)
        self._active_theme = theme_name
        self.sub_title = f"Textual · {theme_name}"
        self.refresh(layout=True)
        self._render_state()

    def _apply_theme_to_node(self, node: ModalScreen[Any]) -> None:
        for candidate in self.THEME_ORDER:
            node.remove_class(f"theme-{candidate}")
        node.add_class(f"theme-{self._active_theme}")

    def _advance_activity_animation(self) -> None:
        if not bool(self._state.get("isBusy", False)):
            return
        self._dot_phase = (self._dot_phase + 1) % 4
        self._render_activity_strip()

    def _render_activity_strip(self) -> None:
        try:
            tool_strip = self.query_one("#tool_strip", Static)
        except NoMatches:
            return

        active_tool = str(self._state.get("activeToolName", "") or "")
        is_busy = bool(self._state.get("isBusy", False))
        dots = "." * (self._dot_phase + 1)

        if active_tool:
            tool_strip.update(f"running tool: {active_tool}{dots}")
            return

        if is_busy:
            tool_strip.update(f"thinking{dots}")
            return

        tool_strip.update("active tool: idle")

    def _append_chat(self, role: str, text: str, final_state: str | None = None) -> None:
        if self._show_welcome:
            self._show_welcome = False
            self._render_layout_state()

        self._chat_items.append(
            {
                "final_state": final_state,
                "role": role,
                "text": text,
            }
        )
        self._render_chat()

    def _handle_streaming_chat_event(
        self,
        role: str,
        text: str,
        final_state: Optional[str],
        stream_id: str,
        chunk: str,
    ) -> None:
        if self._show_welcome:
            self._show_welcome = False
            self._render_layout_state()

        if chunk == "start":
            self._chat_items.append(
                {
                    "final_state": None,
                    "role": role,
                    "text": text,
                }
            )
            self._chat_stream_index_by_id[stream_id] = len(self._chat_items) - 1
            self._render_chat()
            return

        index = self._chat_stream_index_by_id.get(stream_id)
        if index is None or index >= len(self._chat_items):
            self._chat_items.append(
                {
                    "final_state": final_state,
                    "role": role,
                    "text": text,
                }
            )
            self._chat_stream_index_by_id[stream_id] = len(self._chat_items) - 1
            self._render_chat()
            return

        if chunk == "delta":
            current_text = self._chat_items[index].get("text", "") or ""
            self._chat_items[index]["text"] = f"{current_text}{text}"
            self._render_chat()
            return

        if chunk == "end":
            if final_state:
                self._chat_items[index]["final_state"] = final_state
            self._chat_stream_index_by_id.pop(stream_id, None)
            self._render_chat()

    def _render_chat(self) -> None:
        try:
            log = self.query_one("#chat_log", RichLog)
        except NoMatches:
            return

        log.clear()

        total_items = len(self._chat_items)
        for index, item in enumerate(self._chat_items):
            role = item.get("role", "assistant") or "assistant"
            text = item.get("text", "") or ""
            final_state = item.get("final_state")
            log.write(self._build_chat_line(role, text, final_state), expand=True)
            if index < total_items - 1:
                log.write("", expand=True)

    def _build_chat_line(self, role: str, text: str, final_state: str | None) -> Align:
        line = Text()
        alignment = "left"
        label_style = "#6A737D"
        label = "system"
        content: Text | Padding = line

        if role == "user":
            alignment = "right"
            label_style = "#4EA5FF"
            label = "you"
        elif role == "assistant":
            label_style = "#2BEE8C"
            label = "agent"

        line.append(label, style=label_style)
        line.append(": ")
        line.append(text)
        if final_state:
            line.append(f" ({final_state})", style="#88D498")

        if role == "user":
            content = Padding(line, (0, self.CHAT_EDGE_PADDING, 0, 0))
        else:
            content = Padding(line, (0, 0, 0, self.CHAT_EDGE_PADDING))

        return Align(content, align=alignment)
