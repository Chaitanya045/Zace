from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from .app import ZaceTextualApp
from .models import BridgeInitPayload


def _load_json_env(name: str, default: Any) -> Any:
    raw = os.environ.get(name)
    if not raw:
        return default

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Zace Textual UI")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--session-file-path", required=True)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()

    bridge_command = _load_json_env(
        "ZACE_BRIDGE_COMMAND_JSON",
        ["bun", "run", "src/ui/bridge/entry.ts"],
    )
    if not isinstance(bridge_command, list) or not all(isinstance(part, str) for part in bridge_command):
        print("Invalid ZACE_BRIDGE_COMMAND_JSON value.", file=sys.stderr)
        return 1

    ui_config = _load_json_env("ZACE_UI_CONFIG_JSON", {})
    if not isinstance(ui_config, dict):
        ui_config = {}

    payload = BridgeInitPayload(
        session_file_path=args.session_file_path,
        session_id=args.session_id,
        ui_config=ui_config,
    )

    app = ZaceTextualApp(
        bridge_command=list(bridge_command),
        bridge_env=dict(os.environ),
        payload=payload,
        workdir=os.environ.get("ZACE_WORKDIR", os.getcwd()),
    )
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
