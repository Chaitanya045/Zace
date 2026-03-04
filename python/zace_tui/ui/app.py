from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Optional

from pydantic import ValidationError
from rich.align import Align
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.css.query import NoMatches
from textual.screen import ModalScreen
from textual.timer import Timer
from textual.widgets import Footer, Input, RichLog, Static

from ..bridge_client import BridgeError, JsonRpcBridgeClient
from ..models import (
    ApprovalPromptEvent,
    BridgeInitPayload,
    BridgePromptOption,
    ChatMessageEvent,
    ErrorEvent,
    PermissionPromptEvent,
    StateUpdateEvent,
    ToolStatusEvent,
)
from ..protocol import (
    format_validation_error,
    parse_bridge_event,
    parse_init_request_params,
    parse_init_result,
    parse_interrupt_result,
    parse_submit_payload,
    parse_submit_result,
)
from .chat_rendering import ChatItem, apply_stream_chat_chunk, build_chat_line
from .messages import BridgeEventMessage
from .modals import ChoiceModal, HelpModal
from .widgets import ChatRichLog


class ZaceTextualApp(App[None]):
    CSS_PATH = str(Path(__file__).resolve().parent.parent / "theme.tcss")
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
        BridgePromptOption(id="status", label="Show status"),
        BridgePromptOption(id="reset", label="Reset in-memory context"),
        BridgePromptOption(id="help", label="Show keyboard help"),
        BridgePromptOption(id="theme_cycle", label="Cycle theme"),
        BridgePromptOption(id="theme_zace", label="Theme: zace (high contrast)"),
        BridgePromptOption(id="theme_pastel", label="Theme: pastel"),
        BridgePromptOption(id="theme_ocean", label="Theme: ocean"),
        BridgePromptOption(id="exit", label="Exit"),
    ]
    START_META = 'Build GPT-5.2 GitHub Copilot · xhigh'
    START_PLACEHOLDER = 'Ask anything... "Fix broken tests"'
    START_SHORTCUTS = "ctrl+t variants   tab agents   ctrl+p commands"
    START_TIP = "Tip  Use /theme or Ctrl+T to switch themes"
    CHAT_EDGE_PADDING = 2
    CHAT_SCROLLBAR_HIDE_DELAY_SECONDS = 0.6

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
        self._state: dict[str, Any] = {
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
        self._chat_scrollbar_hide_timer: Optional[Timer] = None
        self._active_theme = self._resolve_initial_theme(payload.ui_config)
        self._show_welcome = True
        self._chat_items: list[ChatItem] = []
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
        yield ChatRichLog(id="chat_log", auto_scroll=True, markup=True, highlight=False, wrap=True)
        yield Static(id="tool_strip")
        yield Input(placeholder="Type your message and press Enter", id="composer")
        yield Footer()

    async def on_mount(self) -> None:
        self._apply_theme(self._active_theme)
        self.query_one("#composer", Input).focus()
        self._activity_timer = self.set_interval(0.35, self._advance_activity_animation)
        await self._bridge.start()

        try:
            init_params = parse_init_request_params(
                {
                    "sessionFilePath": self._payload.session_file_path,
                    "sessionId": self._payload.session_id,
                    "uiConfig": self._payload.ui_config,
                }
            )
            init_result_raw = await self._bridge.request("init", init_params.model_dump(exclude_none=True))
        except BridgeError as error:
            self._append_chat("system", f"Bridge init failed: {error}")
            self.exit(1)
            return
        except ValidationError as error:
            self._append_chat("system", f"Bridge init request validation failed: {format_validation_error(error)}")
            self.exit(1)
            return

        try:
            init_result = parse_init_result(init_result_raw)
        except ValidationError as error:
            self._append_chat("system", f"Bridge init payload validation failed: {format_validation_error(error)}")
            self._render_layout_state()
            self._render_state()
            return

        self._state.update(init_result.state.model_dump(exclude_none=True))

        has_messages = False
        for message in init_result.messages:
            has_messages = True
            self._append_chat(message.role, message.text, message.finalState)

        if has_messages or int(self._state.get("turnCount", 0)) > 0:
            self._show_welcome = False

        self._render_layout_state()
        self._render_state()

    async def on_unmount(self) -> None:
        if self._activity_timer is not None:
            self._activity_timer.stop()
            self._activity_timer = None
        if self._chat_scrollbar_hide_timer is not None:
            self._chat_scrollbar_hide_timer.stop()
            self._chat_scrollbar_hide_timer = None
        await self._bridge.stop()

    async def _queue_bridge_event(self, event: dict[str, Any]) -> None:
        self.post_message(BridgeEventMessage(event))

    async def on_bridge_event_message(self, message: BridgeEventMessage) -> None:
        try:
            event = parse_bridge_event(message.event)
        except ValidationError as error:
            self._append_chat("system", f"Ignored malformed bridge event: {format_validation_error(error)}")
            return

        if isinstance(event, StateUpdateEvent):
            self._state.update(event.state.model_dump(exclude_none=True))
            if not bool(self._state.get("isBusy", False)):
                self._interrupt_armed = False
                self._dot_phase = 0
            self._render_state()
            return

        if isinstance(event, ChatMessageEvent):
            if event.streamId and event.chunk in {"start", "delta", "end"}:
                self._handle_streaming_chat_event(event.role, event.text, event.finalState, event.streamId, event.chunk)
                return

            self._append_chat(event.role, event.text, event.finalState)
            return

        if isinstance(event, ToolStatusEvent):
            if event.status == "started":
                self._state["activeToolName"] = event.toolName
            elif event.status == "finished":
                self._state["activeToolName"] = ""
            self._render_state()
            return

        if isinstance(event, ApprovalPromptEvent):
            self.run_worker(self._show_approval_prompt(event), group="bridge_modal", exclusive=True)
            return

        if isinstance(event, PermissionPromptEvent):
            self.run_worker(self._show_permission_prompt(event), group="bridge_modal", exclusive=True)
            return

        if isinstance(event, ErrorEvent):
            self._append_chat("system", event.message)
            self.notify(event.message, severity="warning")
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

        payload = parse_submit_payload(
            {
                "kind": "message",
                "text": text,
            }
        )
        self.run_worker(
            self._submit_payload(payload.model_dump()),
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
                result_raw = await self._bridge.request("interrupt", {})
            except BridgeError as error:
                self._append_chat("system", f"Interrupt failed: {error}")
                await self.action_exit_app()
                return

            try:
                result = parse_interrupt_result(result_raw)
            except ValidationError as error:
                self._append_chat("system", f"Interrupt response validation failed: {format_validation_error(error)}")
                return

            if result.status == "requested":
                self._interrupt_armed = True
                self.notify("Interrupt requested", severity="information")
                return

            if result.status == "already_requested" and self._interrupt_armed:
                await self.action_exit_app()
                return

            if result.status == "already_requested":
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
            result_raw = await self._bridge.request("submit", payload)
        except BridgeError as error:
            self._append_chat("system", f"Submit failed: {error}")
            return

        try:
            result = parse_submit_result(result_raw)
        except ValidationError as error:
            self._append_chat("system", f"Submit response validation failed: {format_validation_error(error)}")
            return

        if bool(result.shouldExit):
            await self.action_exit_app()

    async def _show_approval_prompt(self, event: ApprovalPromptEvent) -> None:
        async with self._modal_lock:
            message = f"{event.prompt}\n\nCommand:\n{event.command}\n\nReason: {event.reason}"
            modal = ChoiceModal(
                title="Approval Required",
                message=message,
                options=event.options,
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

    async def _show_permission_prompt(self, event: PermissionPromptEvent) -> None:
        async with self._modal_lock:
            pattern_text = ", ".join(str(pattern) for pattern in event.patterns)
            message = f"{event.prompt}\n\nPermission: {event.permission}\nPatterns: {pattern_text}"
            modal = ChoiceModal(
                title="Permission Required",
                message=message,
                options=event.options,
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

        payload = parse_submit_payload(
            {
                "kind": "command",
                "command": choice,
            }
        )
        await self._submit_payload(payload.model_dump())

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

        if apply_stream_chat_chunk(
            self._chat_items,
            self._chat_stream_index_by_id,
            role,
            text,
            final_state,
            stream_id,
            chunk,
        ):
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

    def _reveal_chat_scrollbar(self) -> None:
        try:
            chat_log = self.query_one("#chat_log", RichLog)
        except NoMatches:
            return

        if self._show_welcome or not chat_log.display:
            return

        chat_log.add_class("scroll-active")
        if self._chat_scrollbar_hide_timer is not None:
            self._chat_scrollbar_hide_timer.reset()
        else:
            self._chat_scrollbar_hide_timer = self.set_timer(
                self.CHAT_SCROLLBAR_HIDE_DELAY_SECONDS,
                self._hide_chat_scrollbar,
            )

    def _hide_chat_scrollbar(self) -> None:
        try:
            chat_log = self.query_one("#chat_log", RichLog)
        except NoMatches:
            self._chat_scrollbar_hide_timer = None
            return
        if chat_log.is_horizontal_scrollbar_grabbed or chat_log.is_vertical_scrollbar_grabbed:
            self._chat_scrollbar_hide_timer = self.set_timer(
                self.CHAT_SCROLLBAR_HIDE_DELAY_SECONDS,
                self._hide_chat_scrollbar,
            )
            return
        self._chat_scrollbar_hide_timer = None
        chat_log.remove_class("scroll-active")

    def _build_chat_line(self, role: str, text: str, final_state: str | None) -> Align:
        return build_chat_line(role=role, text=text, final_state=final_state, edge_padding=self.CHAT_EDGE_PADDING)
