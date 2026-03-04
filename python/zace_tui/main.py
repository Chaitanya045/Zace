from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from .app import ZaceTextualApp
from .models import BridgeInitPayload


class CliArgsModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    session_file_path: str = Field(min_length=1)
    session_id: str = Field(min_length=1)


def _load_json_env(name: str, default: Any) -> Any:
    raw = os.environ.get(name)
    if not raw:
        return default

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def _parse_args() -> CliArgsModel:
    parser = argparse.ArgumentParser(description="Zace Textual UI")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--session-file-path", required=True)
    namespace = parser.parse_args()
    return CliArgsModel.model_validate(vars(namespace))


def main() -> int:
    try:
        args = _parse_args()
    except ValidationError as error:
        print(f"Invalid CLI arguments: {error}", file=sys.stderr)
        return 1

    bridge_command_raw = _load_json_env(
        "ZACE_BRIDGE_COMMAND_JSON",
        ["bun", "run", "src/ui/bridge/entry.ts"],
    )
    try:
        bridge_command = TypeAdapter(list[str]).validate_python(bridge_command_raw, strict=True)
    except ValidationError:
        print("Invalid ZACE_BRIDGE_COMMAND_JSON value.", file=sys.stderr)
        return 1

    ui_config_raw = _load_json_env("ZACE_UI_CONFIG_JSON", {})
    try:
        ui_config = TypeAdapter(dict[str, Any]).validate_python(ui_config_raw, strict=True)
    except ValidationError:
        ui_config = {}

    try:
        payload = BridgeInitPayload(
            session_file_path=args.session_file_path,
            session_id=args.session_id,
            ui_config=ui_config,
        )
    except ValidationError as error:
        print(f"Invalid initialization payload: {error}", file=sys.stderr)
        return 1

    app = ZaceTextualApp(
        bridge_command=bridge_command,
        bridge_env=dict(os.environ),
        payload=payload,
        workdir=os.environ.get("ZACE_WORKDIR", os.getcwd()),
    )
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
