from __future__ import annotations

from zace_tui.app import BridgeEventMessage, ChatRichLog, RoundedGlassScrollBarRender, ZaceTextualApp


def test_app_module_reexports_public_ui_symbols() -> None:
    assert BridgeEventMessage.__name__ == "BridgeEventMessage"
    assert ChatRichLog.__name__ == "ChatRichLog"
    assert RoundedGlassScrollBarRender.__name__ == "RoundedGlassScrollBarRender"
    assert ZaceTextualApp.__name__ == "ZaceTextualApp"
