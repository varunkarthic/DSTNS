# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Realistic News: which model the server should use to write the news, if any.

The server can word incidents, storms and floods in plain language with Apple's
on-device Foundation Model (the ``fm`` command) or any Chat Completions
endpoint. The launcher decides before it starts the server, so that it can say
why narration is off - ``fm`` missing, the model not available, Apple's terms
not accepted, an endpoint not answering - and fall back to the default wording
explicitly rather than leaving the server to discover it. Narration is cosmetic:
whatever is chosen here, the simulation runs the same.

The mode comes from ``--narrator``, else ``DSTNS_NARRATOR``, else
``narration.mode`` in config/defaults.json, else ``auto``.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import configuration
from .paths import PATHS, Paths

if TYPE_CHECKING:
    from .reporting import Reporter

ENV = "DSTNS_NARRATOR"
MODES = ("auto", "fm", "off")
FM_LABEL = "Apple Foundation Models (on device)"
DEFAULT_WORDING = "Standard news"
BRAND = "Realistic News"
#: How the launcher reports Apple's on-device model.
AVAILABLE, UNAVAILABLE, DISABLED = "Available", "Unavailable", "Disabled"
SYSTEM_FM = Path("/usr/bin/fm")


@dataclass(frozen=True)
class Choice:
    """What was asked for, what the server will be told, and why."""

    requested: str
    server_argument: str           # the value passed to dstns_server --narrator
    label: str                     # what is running, for display
    reason: str = ""               # why narration is off or not what was asked for
    remedy: str = ""

    @property
    def enabled(self) -> bool:
        return self.server_argument != "off"

    @property
    def fell_back(self) -> bool:
        """Narration was wanted but is not available, so the default wording applies."""
        return not self.enabled and self.requested != "off"

    @property
    def fm_status(self) -> str:
        """Apple Foundation Models: Available (in use), Unavailable (wanted but
        missing, unsupported or not ready), or Disabled (turned off, or another
        model chosen)."""
        if self.server_argument == "fm":
            return AVAILABLE
        return UNAVAILABLE if self.requested in {"auto", "fm"} else DISABLED

    def summary(self) -> str:
        if self.enabled:
            return f"Apple Foundation Models: {self.fm_status} · {BRAND} via {self.label}"
        return f"Apple Foundation Models: {self.fm_status} · {DEFAULT_WORDING}" + (f" ({self.reason})" if self.reason else "")


def requested_mode(paths: Paths = PATHS) -> str:
    value = os.environ.get(ENV, "").strip()
    if not value:
        try:
            value = str(((configuration.load(paths).get("narration") or {}).get("mode")) or "")
        except Exception:  # noqa: BLE001 - an invalid configuration is reported by its own check
            value = ""
    return value or "auto"


def valid_mode(value: str) -> bool:
    return value in MODES or value.startswith(("http://", "unix:/"))


def find_fm() -> Path | None:
    if sys.platform != "darwin":
        return None
    found = shutil.which("fm")
    if found:
        return Path(found)
    return SYSTEM_FM if os.access(SYSTEM_FM, os.X_OK) else None


def _run(command: list[str], timeout: float = 15) -> tuple[int, str]:
    try:
        result = subprocess.run(command, capture_output=True, text=True, errors="replace", timeout=timeout,
                                stdin=subprocess.DEVNULL, env={**os.environ, "NO_COLOR": "1"})
        return result.returncode, (result.stdout + result.stderr).strip()
    except FileNotFoundError:
        return 127, f"{command[0]} not found"
    except subprocess.TimeoutExpired:
        return -1, "did not answer within 15 seconds"
    except OSError as exc:
        return 126, str(exc)


def _first_line(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:160]
    return ""


def _check_fm(requested: str) -> Choice:
    off = lambda reason, remedy="": Choice(requested, "off", "off", reason, remedy)  # noqa: E731
    if sys.platform != "darwin":
        return off("Apple Foundation Models are only available on macOS",
                   "Point --narrator at a Chat Completions endpoint (llama.cpp, Ollama) to narrate here.")
    fm = find_fm()
    if fm is None:
        return off("the fm command was not found",
                   "Apple Foundation Models need macOS 26 or later with Apple Intelligence on Apple silicon.")
    code, out = _run([str(fm), "available"])
    if code != 0 or "available" not in out.lower() or "not available" in out.lower() or "unavailable" in out.lower():
        return off(f"the on-device model is not available ({_first_line(out) or f'exit {code}'})",
                   "Turn on Apple Intelligence in System Settings and let the model finish downloading.")
    code, out = _run([str(fm), "license", "--status"])
    if code != 0 or "agreed" not in out.lower() or "not agreed" in out.lower():
        return off("Apple's Foundation Models terms have not been accepted",
                   "Run fm license once in a terminal to read and accept them.")
    return Choice(requested, "fm", FM_LABEL)


def _check_endpoint(requested: str) -> Choice:
    label = f"Chat Completions at {requested}"
    if requested.startswith("unix:"):
        socket = requested[5:]
        if not os.path.exists(socket):
            return Choice(requested, "off", "off", f"no socket at {socket}", "Start the model server first.")
        return Choice(requested, requested, label)
    url = requested.rstrip("/")
    if url.endswith("/v1"):
        url = url[:-3]
    try:
        with urllib.request.urlopen(url + "/v1/models", timeout=3) as response:
            if response.status == 200:
                return Choice(requested, requested, label)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return Choice(requested, "off", "off", f"{requested} is not answering ({getattr(exc, 'reason', exc)})",
                      "Start the model server, or set --narrator auto to use Apple's on-device model.")
    return Choice(requested, "off", "off", f"{requested} did not list its models", "Check the endpoint address.")


def resolve(requested: str | None = None, paths: Paths = PATHS) -> Choice:
    """Decide what the server should use. Never raises: anything wrong means off."""
    requested = (requested or requested_mode(paths)).strip()
    if requested in {"off", "none"}:
        return Choice("off", "off", "off", "turned off")
    if requested in {"auto", "fm"}:
        return _check_fm(requested)
    if requested.startswith(("http://", "unix:/")):
        return _check_endpoint(requested)
    if requested.startswith("https://"):
        return Choice(requested, "off", "off", "the engine speaks plain HTTP only",
                      "Use an http:// address, with a TLS proxy in front of a remote model.")
    return Choice(requested, "off", "off", f'"{requested}" is not a narration mode',
                  "Use auto, fm, off, http://HOST:PORT or unix:/PATH.")


def describe_server(status: dict[str, Any] | None) -> tuple[str, str]:
    """(state, text) for the server's /api/v1/system/narrator report."""
    if not status:
        return "unknown", "the server did not report narration (an older server?)"
    if not status.get("enabled"):
        return "off", f"Apple Foundation Models: {DISABLED} or {UNAVAILABLE} · {DEFAULT_WORDING}"
    backend = status.get("backend") or {}
    apple = backend.get("kind") == "apple-foundation-models"
    name = "Apple Foundation Models" if apple else f"Chat Completions at {backend.get('endpoint', '?')}"
    state = str(status.get("state") or "unknown")
    if state == "ready":
        return "ready", (f"{name}: {AVAILABLE}" if apple else name) + f" · {status.get('completed', 0)} items written"
    if state == "starting":
        return "starting", (f"{name}: {AVAILABLE}" if apple else name) + " · loading the model"
    if state in {"backoff", "unavailable"}:
        reason = status.get("last_error") or state
        return state, (f"{name}: {UNAVAILABLE} ({reason})" if apple else f"{name} is not answering ({reason})") + f"; {DEFAULT_WORDING}"
    return state, name



# --- Telling the operator ------------------------------------------------------


def announce(choice: Choice, reporter: "Reporter") -> None:
    """Say, before the server starts, what narration it will use."""
    from .reporting import Level

    title = f"Apple Foundation Models: {choice.fm_status}"
    if choice.fm_status == AVAILABLE:
        reporter.message(Level.SUCCESS, title, f"{BRAND} on: news written on this Mac from each event and its context")
    elif choice.fm_status == UNAVAILABLE:
        detail = choice.reason + (f". {choice.remedy}" if choice.remedy else "")
        reporter.message(Level.WARNING, title, f"{detail} Using {DEFAULT_WORDING}.")
    elif choice.enabled:
        reporter.message(Level.INFO, title, f"{BRAND} via {choice.label}")
    elif choice.fell_back:
        reporter.message(Level.WARNING, f"{title} · {BRAND} unavailable",
                         choice.reason + (f". {choice.remedy}" if choice.remedy else "") + f" Using {DEFAULT_WORDING}.")
    else:
        reporter.message(Level.INFO, title, f"turned off; {DEFAULT_WORDING}")


def server_status(port: int, paths: Paths = PATHS) -> dict[str, Any] | None:
    from . import api

    response = api.call(port, "/api/v1/system/narrator", timeout=3, paths=paths)
    data = (response.body or {}).get("data") if response.ok and isinstance(response.body, dict) else None
    return data if isinstance(data, dict) else None


def confirm(port: int, reporter: "Reporter", paths: Paths = PATHS, *, wait: float = 6.0, cancel=None) -> None:
    """After the run starts, report what the server's narrator actually did.

    The model loads on first use, so give it a few seconds; if it fails the
    server falls back to the default wording by itself, and this says so.
    """
    import time

    from .reporting import Level

    deadline = time.monotonic() + wait
    status = server_status(port, paths)
    while status and status.get("enabled") and status.get("state") == "starting" and time.monotonic() < deadline:
        if cancel is not None and cancel.is_set():
            return
        time.sleep(0.25)
        status = server_status(port, paths)
    state, text = describe_server(status)
    if state == "ready":
        reporter.message(Level.SUCCESS, f"{BRAND} ready", text)
    elif state == "starting":
        reporter.message(Level.INFO, f"{BRAND} starting", text + f"; {DEFAULT_WORDING} is shown until it is ready")
    elif state in {"backoff", "unavailable"}:
        reporter.message(Level.WARNING, f"{BRAND} unavailable: using {DEFAULT_WORDING}", text)
