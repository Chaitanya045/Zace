from __future__ import annotations

import sys
from typing import Any

import pytest

from zace_tui import main as main_module


def _set_required_args(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "zace-textual-ui",
            "--session-id",
            "test-session",
            "--session-file-path",
            ".zace/sessions/test.jsonl",
        ],
    )


def test_main_rejects_invalid_bridge_command_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_args(monkeypatch)
    monkeypatch.setenv("ZACE_BRIDGE_COMMAND_JSON", "{\"bad\":true}")

    exit_code = main_module.main()

    assert exit_code == 1


def test_main_falls_back_to_empty_ui_config_for_invalid_json_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class _FakeApp:
        def __init__(
            self,
            bridge_command: list[str],
            bridge_env: dict[str, str],
            payload: Any,
            workdir: str,
        ) -> None:
            captured["bridge_command"] = bridge_command
            captured["bridge_env"] = bridge_env
            captured["payload"] = payload
            captured["workdir"] = workdir

        def run(self) -> None:
            captured["ran"] = True

    _set_required_args(monkeypatch)
    monkeypatch.setenv("ZACE_BRIDGE_COMMAND_JSON", "[\"bun\",\"run\",\"src/ui/bridge/entry.ts\"]")
    monkeypatch.setenv("ZACE_UI_CONFIG_JSON", "[]")
    monkeypatch.setattr(main_module, "ZaceTextualApp", _FakeApp)

    exit_code = main_module.main()

    assert exit_code == 0
    assert captured["ran"] is True
    assert captured["payload"].ui_config == {}


def test_main_requires_cli_args(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["zace-textual-ui"])

    with pytest.raises(SystemExit):
        main_module.main()
