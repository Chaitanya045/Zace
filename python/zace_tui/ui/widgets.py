from __future__ import annotations

from textual import events
from textual.widgets import RichLog

from .scrollbar import RoundedGlassScrollBarRender


class ChatRichLog(RichLog):
    def _refresh_scrollbars(self) -> None:
        super()._refresh_scrollbars()
        if self._vertical_scrollbar is not None:
            self._vertical_scrollbar.renderer = RoundedGlassScrollBarRender
        if self._horizontal_scrollbar is not None:
            self._horizontal_scrollbar.renderer = RoundedGlassScrollBarRender

    def _notify_scroll_activity(self) -> None:
        reveal = getattr(self.app, "_reveal_chat_scrollbar", None)
        if callable(reveal):
            reveal()

    def _on_mouse_scroll_down(self, event: events.MouseScrollDown) -> None:
        self._notify_scroll_activity()
        super()._on_mouse_scroll_down(event)

    def _on_mouse_scroll_up(self, event: events.MouseScrollUp) -> None:
        self._notify_scroll_activity()
        super()._on_mouse_scroll_up(event)
