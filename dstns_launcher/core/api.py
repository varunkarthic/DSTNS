# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""A small client for the DSTNS HTTP API."""
from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .paths import PATHS, Paths


@dataclass
class Response:
    code: int
    body: Any

    @property
    def ok(self) -> bool:
        return 200 <= self.code < 300

    def error_message(self) -> str:
        body = self.body if isinstance(self.body, dict) else {}
        error = body.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("code") or f"HTTP {self.code}")
        return str(error or body.get("message") or f"HTTP {self.code}")

    def error_code(self) -> str:
        body = self.body if isinstance(self.body, dict) else {}
        error = body.get("error")
        return str(error.get("code", "")) if isinstance(error, dict) else ""


def operator_token(paths: Paths = PATHS) -> str:
    """The credential that lets the launcher start runs."""
    from_env = os.environ.get("DSTNS_OPERATOR_TOKEN")
    if from_env:
        return from_env
    try:
        return paths.token.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def call(
    port: int,
    route: str,
    method: str = "GET",
    payload: Any = None,
    *,
    timeout: float = 120.0,
    host: str = "127.0.0.1",
    paths: Paths = PATHS,
) -> Response:
    """Call the API. Network failures come back as code 0 with the reason."""
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(f"http://{host}:{port}{route}", data=data, method=method)
    request.add_header("Content-Type", "application/json")
    token = operator_token(paths)
    if token:
        request.add_header("X-DSTNS-Operator", token)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return Response(response.status, _decode(response.read()))
    except urllib.error.HTTPError as exc:
        with exc:
            return Response(exc.code, _decode(exc.read()))
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        return Response(0, {"error": {"code": "UNREACHABLE", "message": str(reason)}})


def _decode(raw: bytes) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {"message": raw.decode(errors="replace")}


def health(port: int, *, timeout: float = 1.0, paths: Paths = PATHS) -> dict[str, Any] | None:
    """The server's ``/health`` if a DSTNS server answers on ``port``."""
    response = call(port, "/health", timeout=timeout, paths=paths)
    if response.code != 200 or not isinstance(response.body, dict):
        return None
    body = response.body
    return body if body.get("product") == "DSTNS" or body.get("service") == "dstns" else None


def is_current(health_body: dict[str, Any] | None) -> bool:
    """A server this launcher can drive (an older DSTNS is left alone)."""
    return bool(health_body) and health_body.get("observer_ui_version") == "observer-v2"


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def free_port(start: int, host: str = "127.0.0.1") -> int:
    for port in range(start, 65535):
        if not port_open(port, host):
            return port
    raise OSError("No available network ports found")
