from __future__ import annotations

import asyncio
from typing import Any

import pytest

from zace_tui.bridge_client import JsonRpcBridgeClient


class _DummyStdin:
    def write(self, data: bytes) -> None:
        del data

    async def drain(self) -> None:
        return None


class _DummyProcess:
    def __init__(self) -> None:
        self.returncode = 0
        self.stdin = _DummyStdin()
        self.stdout: asyncio.StreamReader = asyncio.StreamReader()
        self.stderr: asyncio.StreamReader = asyncio.StreamReader()


async def _run_stdout_reader(
    client: JsonRpcBridgeClient,
    lines: list[bytes],
) -> None:
    process = _DummyProcess()
    client._process = process  # type: ignore[attr-defined]
    for line in lines:
        process.stdout.feed_data(line)
    process.stdout.feed_eof()
    await client._read_stdout()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_bridge_client_emits_error_for_malformed_json() -> None:
    events: list[dict[str, Any]] = []

    async def on_event(event: dict[str, Any]) -> None:
        events.append(event)

    client = JsonRpcBridgeClient(command=["echo"], cwd=".", env={}, on_event=on_event)
    await _run_stdout_reader(client, [b"{invalid-json}\n"])

    assert any("invalid JSON" in str(event.get("message", "")) for event in events)


@pytest.mark.asyncio
async def test_bridge_client_emits_error_for_schema_invalid_event() -> None:
    events: list[dict[str, Any]] = []

    async def on_event(event: dict[str, Any]) -> None:
        events.append(event)

    client = JsonRpcBridgeClient(command=["echo"], cwd=".", env={}, on_event=on_event)
    await _run_stdout_reader(
        client,
        [
            b'{"type":"event","event":{"type":"chat_message","role":"assistant","timestamp":1}}\n',
        ],
    )

    assert any("malformed payload" in str(event.get("message", "")) for event in events)


@pytest.mark.asyncio
async def test_bridge_client_resolves_valid_response_payload() -> None:
    events: list[dict[str, Any]] = []

    async def on_event(event: dict[str, Any]) -> None:
        events.append(event)

    client = JsonRpcBridgeClient(command=["echo"], cwd=".", env={}, on_event=on_event)
    future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
    client._pending["7"] = future  # type: ignore[attr-defined]

    await _run_stdout_reader(
        client,
        [
            b'{"type":"response","id":"7","success":true,"result":{"ok":true}}\n',
        ],
    )

    assert future.done()
    assert future.result() == {"ok": True}
    assert events == []
