from __future__ import annotations

from typing import Optional

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import OptionList, Static
from textual.widgets.option_list import Option

from ..models import BridgePromptOption


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
            OptionList(*[Option(option.label, id=option.id) for option in self._options], id="modal_options"),
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
