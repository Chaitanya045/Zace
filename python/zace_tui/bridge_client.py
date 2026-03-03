from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any


class BridgeError(RuntimeError):
    """Raised when the bridge returns an error or closes unexpectedly."""


class JsonRpcBridgeClient:
    def __init__(
        self,
        command: list[str],
        cwd: str,
        env: dict[str, str],
        on_event: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        self._command = command
        self._cwd = cwd
        self._env = env
        self._on_event = on_event
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._request_id = 0
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}

    async def start(self) -> None:
        if self._process:
            return

        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            cwd=self._cwd,
            env=self._env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        self._reader_task = asyncio.create_task(self._read_stdout(), name="zace_bridge_stdout")
        self._stderr_task = asyncio.create_task(self._read_stderr(), name="zace_bridge_stderr")

    async def stop(self) -> None:
        if not self._process:
            return

        try:
            await self.request("shutdown", {})
        except Exception:
            pass

        if self._reader_task:
            self._reader_task.cancel()
        if self._stderr_task:
            self._stderr_task.cancel()

        process = self._process
        self._process = None
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1.5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if not self._process or not self._process.stdin:
            raise BridgeError("Bridge process is not started.")

        request_id = str(self._request_id)
        self._request_id += 1

        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        payload = {
            "id": request_id,
            "method": method,
            "params": params,
            "type": "request",
        }
        raw = json.dumps(payload) + "\n"

        self._process.stdin.write(raw.encode("utf-8"))
        await self._process.stdin.drain()

        try:
            return await future
        finally:
            self._pending.pop(request_id, None)

    async def _read_stdout(self) -> None:
        assert self._process is not None
        assert self._process.stdout is not None

        while True:
            line = await self._process.stdout.readline()
            if not line:
                self._fail_pending("Bridge closed stdout unexpectedly.")
                return

            try:
                payload = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                await self._on_event(
                    {
                        "message": "Bridge emitted invalid JSON.",
                        "type": "error",
                    }
                )
                continue

            payload_type = payload.get("type")
            if payload_type == "response":
                await self._handle_response(payload)
                continue

            if payload_type == "event":
                event = payload.get("event")
                if isinstance(event, dict):
                    await self._on_event(event)
                else:
                    await self._on_event(
                        {
                            "message": "Bridge emitted malformed event payload.",
                            "type": "error",
                        }
                    )
                continue

            await self._on_event(
                {
                    "message": "Bridge emitted unsupported message type.",
                    "type": "error",
                }
            )

    async def _handle_response(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get("id", ""))
        future = self._pending.get(request_id)
        if not future:
            return

        if payload.get("success") is True:
            result = payload.get("result")
            if isinstance(result, dict):
                future.set_result(result)
            else:
                future.set_result({})
            return

        error_message = payload.get("error")
        if isinstance(error_message, str) and error_message:
            future.set_exception(BridgeError(error_message))
        else:
            future.set_exception(BridgeError("Bridge request failed."))

    async def _read_stderr(self) -> None:
        assert self._process is not None
        assert self._process.stderr is not None

        while True:
            line = await self._process.stderr.readline()
            if not line:
                return

            text = line.decode("utf-8", errors="replace").strip()
            if text:
                await self._on_event(
                    {
                        "message": f"[bridge] {text}",
                        "type": "error",
                    }
                )

    def _fail_pending(self, message: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(BridgeError(message))
        self._pending.clear()
