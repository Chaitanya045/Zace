from __future__ import annotations

from typing import Any

from textual.message import Message


class BridgeEventMessage(Message):
    def __init__(self, event: dict[str, Any]) -> None:
        super().__init__()
        self.event = event
