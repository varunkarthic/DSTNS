# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Finding, starting, watching and stopping the DSTNS server process."""
from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from . import api, build, configuration
from .process import check_cancelled
from .errors import ConfigurationError, SimulationStartError
from .paths import PATHS, Paths
from .reporting import Level, Reporter

LOG = logging.getLogger("dstns.launcher")
HEALTH_TIMEOUT = 15.0


@dataclass
class ServerHandle:
    """A server this launcher is using: one it started, or one it attached to."""

    port: int
    host: str
    health: dict[str, Any]
    process: subprocess.Popen[str] | None = None
    output: deque[str] = field(default_factory=lambda: deque(maxlen=500))

    @property
    def managed(self) -> bool:
        return self.process is not None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    def running(self) -> bool:
        if self.process is not None:
            return self.process.poll() is None
        return api.health(self.port) is not None

    def exit_code(self) -> int | None:
        return None if self.process is None else self.process.poll()


def configured_port(paths: Paths = PATHS) -> int:
    """The port to try first: DSTNS_API_PORT, else the last one used, else api.port."""
    config = configuration.load(paths)
    raw = os.environ.get("DSTNS_API_PORT")
    if raw:
        if not raw.isdigit() or not 1 <= int(raw) <= 65535:
            raise ConfigurationError("Invalid DSTNS_API_PORT", remedy="Set it to a port number between 1 and 65535.")
        return int(raw)
    previous = _read_active(paths)
    if previous and api.is_current(api.health(int(previous), paths=paths)):
        return int(previous)
    return int(config["api"]["port"])


def active_port(paths: Paths = PATHS, extra: list[int] | None = None) -> int | None:
    """The port of a current DSTNS server this launcher can reach, if any."""
    candidates = list(extra or [])
    previous = _read_active(paths)
    if previous:
        candidates.append(int(previous))
    try:
        candidates.append(configured_port(paths))
    except ConfigurationError:
        pass
    for port in dict.fromkeys(candidates):
        if api.is_current(api.health(port, paths=paths)):
            return port
    return None


def start(reporter: Reporter, paths: Paths = PATHS, *, build_first: bool = True,
          cancel: threading.Event | None = None) -> ServerHandle:
    """Attach to a healthy current server, or build and start one."""
    check_cancelled(cancel)
    config = configuration.load(paths)
    port = configured_port(paths)
    host = config["api"].get("host") or "127.0.0.1"
    paths.logs.mkdir(parents=True, exist_ok=True)
    if build_first:
        build.ensure_built(reporter, paths, cancel=cancel)

    check_cancelled(cancel)

    if api.port_open(port, host):
        existing = api.health(port, paths=paths)
        if api.is_current(existing):
            _write_active(paths, port)
            reporter.message(Level.INFO, "Attached to the running DSTNS server",
                             f"port {port} · {(existing or {}).get('lifecycle', 'READY')}")
            return ServerHandle(port, host, existing or {})
        replacement = api.free_port(port + 1)
        reporter.message(Level.WARNING,
                         f"Port {port} is serving {'an older DSTNS version' if existing else 'another service'}",
                         f"using {replacement}")
        port = replacement

    command = [str(paths.server), "--host", host, "--port", str(port), "--logs", str(paths.logs)]
    check_cancelled(cancel)
    reporter.message(Level.INFO, "Starting the DSTNS server", f"127.0.0.1:{port}")
    LOG.info("server start: %s", " ".join(command))
    try:
        child = subprocess.Popen(command, cwd=paths.root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, errors="replace", bufsize=1)
    except OSError as exc:
        raise SimulationStartError("The DSTNS server could not be started.",
                                   remedy="Build it with ./launcher test unit, or run cmake --build build.") from exc
    handle = ServerHandle(port, host, {}, child)
    threading.Thread(target=_drain, args=(child, handle.output), daemon=True).start()

    try:
        deadline = time.monotonic() + HEALTH_TIMEOUT
        while time.monotonic() < deadline:
            check_cancelled(cancel)
            if child.poll() is not None:
                raise SimulationStartError(
                    f"The server exited with status {child.returncode} before it was ready.",
                    remedy="See the server output below, or logs/system.log.",
                    detail="\n".join(list(handle.output)[-14:]))
            health = api.health(port, paths=paths)
            if health:
                check_cancelled(cancel)
                handle.health = health
                _write_active(paths, port)
                reporter.message(Level.SUCCESS, "The DSTNS server is healthy", f"port {port} · {health.get('lifecycle', 'READY')}")
                return handle
            time.sleep(0.25)
    except BaseException:
        stop_process(child)
        raise
    stop_process(child)
    raise SimulationStartError(
        f"Server did not become healthy within {HEALTH_TIMEOUT:g}s on port {port}.",
        remedy="Check that logs/ is writable, then try again; ./launcher reset clears stale runtime files.",
        detail="\n".join(list(handle.output)[-14:]))


def run_foreground(paths: Paths = PATHS) -> int:
    """``--mode=server``: build if needed, then run the server attached to this terminal."""
    config = configuration.load(paths)
    port = configured_port(paths)
    host = config["api"].get("host") or "127.0.0.1"
    paths.logs.mkdir(parents=True, exist_ok=True)
    build.ensure_built(Reporter(), paths)
    if api.port_open(port, host):
        existing = api.health(port, paths=paths)
        if api.is_current(existing):
            _write_active(paths, port)
            print(f"A DSTNS server is already running on port {port}.")
            return 0
        port = api.free_port(port + 1)
    return subprocess.call([str(paths.server), "--host", host, "--port", str(port), "--logs", str(paths.logs)],
                           cwd=paths.root)


def shut_down(handle: ServerHandle, *, wait: float = 10.0) -> bool:
    """Ask the server to terminate, wait, then escalate for a server we started.

    Returns whether the server has actually stopped.
    """
    response = api.call(handle.port, "/api/v1/system/terminate", "POST", {}, timeout=5)
    LOG.info("terminate requested on port %s: HTTP %s", handle.port, response.code)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if not handle.running():
            return True
        time.sleep(0.2)
    if handle.process is not None:
        stop_process(handle.process)
        return handle.process.poll() is not None
    return not handle.running()


def stop_process(child: subprocess.Popen[str], grace: float = 1.5) -> None:
    """SIGTERM, then SIGKILL if the process has not exited within ``grace`` seconds."""
    if child.poll() is not None:
        return
    try:
        child.send_signal(signal.SIGTERM)
        child.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)
    except OSError:
        pass


def _drain(child: subprocess.Popen[str], sink: deque[str]) -> None:
    # Reading continuously keeps the server from blocking on a full pipe.
    assert child.stdout is not None
    for line in child.stdout:
        sink.append(line.rstrip("\n"))


def _read_active(paths: Paths) -> int | None:
    try:
        port = json.loads(paths.active_server.read_text(encoding="utf-8")).get("port")
        return int(port) if port else None
    except (OSError, ValueError, TypeError):
        return None


def _write_active(paths: Paths, port: int) -> None:
    paths.logs.mkdir(parents=True, exist_ok=True)
    paths.active_server.write_text(json.dumps({"port": port, "observer_ui_version": "observer-v2"}), encoding="utf-8")
