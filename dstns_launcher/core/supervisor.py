# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Starting applications, waiting until they are ready, and looking after them.

Each application runs in its own process group, with no shell: a command is one program and its
arguments, so what is in the catalogue is exactly what runs. Output goes to a log of its own. The
operator's credential is not passed on: an application proves who it is with its own token.
"""
from __future__ import annotations

import hashlib
import logging
import os
import secrets
import re
import shlex
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from . import fabric
from .apps import App
from .errors import DSTNSLauncherError, OperationCancelled
from .paths import PATHS, Paths
from .reporting import Level, Reporter

LOG = logging.getLogger("dstns.launcher")
POLL_SECONDS = 0.2
STOP_SECONDS = 4.0
# Doubling from here between restarts, so that one that cannot start does not spin.
RESTART_BACKOFF_S = 1.0
MAX_RESTARTS = 5
# A run this long has recovered, so its restarts stop counting against it.
STABLE_AFTER_S = 60.0
_TOKEN = re.compile(r"\{(url|port|id|root)\}")


class AppStartError(DSTNSLauncherError):
    """An application the simulation needs did not become ready."""


class Phase(str, Enum):
    WAITING = "waiting"
    PREPARING = "preparing"
    STARTING = "starting"
    READY = "ready"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass
class Running:
    app: App
    phase: Phase = Phase.WAITING
    detail: str = ""
    restarts: int = 0
    process: subprocess.Popen | None = None
    log: Path | None = None
    stop: threading.Event = field(default_factory=threading.Event)
    settled: threading.Event = field(default_factory=threading.Event)
    # A person asked for it to start again: the next exit is that, not a failure.
    reloading: threading.Event = field(default_factory=threading.Event)
    launch_key: str = ""
    thread: threading.Thread | None = None


def expand(command: str, values: dict[str, str]) -> list[str]:
    """One program and its arguments, with {url}, {port}, {id} and {root} filled in."""
    return [_TOKEN.sub(lambda match: values[match.group(1)], part) for part in shlex.split(command)]


def tail(path: Path | None, lines: int = 3) -> str:
    try:
        return " / ".join(line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:] if line.strip()) if path else ""
    except OSError:
        return ""


class Supervisor:
    def __init__(self, port: int, reporter: Reporter | None = None, paths: Paths = PATHS, cancel: threading.Event | None = None) -> None:
        self.port = port
        self.reporter = reporter or Reporter()
        self.paths = paths
        self.cancel = cancel or threading.Event()
        self.running: dict[str, Running] = {}
        self._lock = threading.Lock()
        self.publish_plan = False
        self._watcher: threading.Thread | None = None
        self._reloads_seen = -1

    # -- what is going on --------------------------------------------------------
    def states(self) -> list[Running]:
        with self._lock:
            return list(self.running.values())

    def _changed(self) -> None:
        if not self.publish_plan:
            return
        plan = {"apps": [{"id": r.app.id, "name": r.app.title, "state": r.phase.value, "detail": r.detail,
                          **({"web_url": r.app.web_url, "web_label": r.app.web_label or f"Open {r.app.title}"} if r.app.web_url else {})}
                         for r in self.states()]}
        fabric.set_plan(self.port, plan, self.paths)

    def _set(self, running: Running, phase: Phase, detail: str = "") -> None:
        running.phase = phase
        running.detail = detail
        self._changed()

    # -- starting ----------------------------------------------------------------
    def launch(self, apps: list[App]) -> None:
        """Start these, and return once all are ready. A required one that fails raises."""
        if not apps:
            return
        self.publish_plan = True
        try:
            for app in apps:
                self.start(app)
            while not all(self.running[app.id].settled.is_set() for app in apps):
                if self.cancel.is_set():
                    self.stop_all()
                    raise OperationCancelled()
                time.sleep(POLL_SECONDS)
            failed = [self.running[app.id] for app in apps if self.running[app.id].phase is not Phase.READY]
            needed = [running for running in failed if running.app.required]
            for running in failed:
                self.reporter.message(Level.ERROR if running.app.required else Level.WARNING, f"{running.app.title} did not start", running.detail)
            if needed:
                self.stop_all()
                raise AppStartError(f"{needed[0].app.title} is required, and did not start: {needed[0].detail}",
                                    remedy=f"Its log is at {needed[0].log}. Run ./launcher apps doctor {needed[0].app.id} to check it.")
        except BaseException:
            self.publish_plan = False
            fabric.set_plan(self.port, None, self.paths)
            raise
        # The plan stays while they run: it is how the server knows which applications the launcher looks after,
        # so that one a person reloads can come back as itself, and where each one's web interface is.

    def start(self, app: App) -> Running:
        """Start one, in the background. Its thread looks after it from then on."""
        self.publish_plan = True
        with self._lock:
            current = self.running.get(app.id)
            if current and current.process and current.process.poll() is None:
                return current
            log_dir = self.paths.logs / "apps"
            log_dir.mkdir(parents=True, exist_ok=True)
            running = Running(app, log=log_dir / f"{app.id}.log")
            self.running[app.id] = running
        running.thread = threading.Thread(target=self._look_after, args=(running,), daemon=True, name=f"app-{app.id}")
        running.thread.start()
        if self._watcher is None:
            self._watcher = threading.Thread(target=self._watch_reloads, daemon=True, name="app-reloads")
            self._watcher.start()
        return running

    def _watch_reloads(self) -> None:
        """A person reloads an application in the observer: its link ends, and this starts it again."""
        while not self.cancel.wait(0.5):
            try:
                asked = fabric.reloads(self.port, self.paths)
            except Exception:  # noqa: BLE001 - a server that is going away is not this thread's to report
                continue
            if self._reloads_seen < 0:
                self._reloads_seen = max((item.get("sequence", 0) for item in asked), default=0)
                continue
            for item in asked:
                if item.get("sequence", 0) <= self._reloads_seen:
                    continue
                self._reloads_seen = item["sequence"]
                running = self.running.get(item.get("app", ""))
                if running and running.process and running.process.poll() is None:
                    self.reporter.message(Level.INFO, f"Reloading {running.app.title}")
                    running.reloading.set()
                    self._kill(running.process)
            if self.running and all(r.phase in (Phase.STOPPED, Phase.FAILED) for r in self.states()):
                return

    def _environment(self, app: App, launch_key: str = "") -> dict[str, str]:
        env = {key: value for key, value in os.environ.items() if key not in ("DSTNS_OPERATOR_TOKEN", "DSTNS_FABRIC_LAUNCH_KEY")}
        env.update(app.env)
        env.update(DSTNS_URL=self._values(app)["url"], DSTNS_PORT=str(self.port), DSTNS_APP_ID=app.id, PYTHONUNBUFFERED="1")
        if launch_key:
            env["DSTNS_FABRIC_LAUNCH_KEY"] = launch_key
        return env

    def _values(self, app: App) -> dict[str, str]:
        return {"url": f"http://127.0.0.1:{self.port}", "port": str(self.port), "id": app.id, "root": str(self.paths.root)}

    def _spawn(self, running: Running, command: str, launch_key: str = "") -> subprocess.Popen:
        app = running.app
        with open(running.log, "ab", buffering=0) as log:
            log.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} {command}\n".encode())
            # A process group of its own, so that what it starts is stopped with it.
            return subprocess.Popen(expand(command, self._values(app)), cwd=self.paths.root / app.cwd, env=self._environment(app, launch_key),
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)

    def _look_after(self, running: Running) -> None:
        app = running.app
        try:
            *prepare, main = app.commands
            for command in prepare:
                self._set(running, Phase.PREPARING, command)
                process = running.process = self._spawn(running, command)
                deadline = time.monotonic() + app.timeout_s
                while process.poll() is None:
                    if running.stop.is_set() or self.cancel.is_set():
                        self._kill(process)
                        return self._set(running, Phase.STOPPED)
                    if time.monotonic() > deadline:
                        self._kill(process)
                        raise AppStartError(f"Preparing took over {app.timeout_s:.0f} s: {command}")
                    time.sleep(POLL_SECONDS)
                if process.returncode != 0:
                    raise AppStartError(f"{command} failed with status {process.returncode}. {tail(running.log)}".strip())
            self._run(running, main)
        except (OSError, ValueError) as exc:
            self._set(running, Phase.FAILED, f"It could not be started: {exc}")
        except AppStartError as exc:
            self._set(running, Phase.FAILED, str(exc))
        finally:
            running.settled.set()

    def _run(self, running: Running, command: str) -> None:
        app = running.app
        while not running.stop.is_set() and not self.cancel.is_set():
            self._set(running, Phase.STARTING)
            began = time.monotonic()
            # A key for this process alone, so that it can prove to the server to be this application.
            running.launch_key = secrets.token_hex(32)
            fabric.set_launch_key(self.port, app.id, hashlib.sha256(running.launch_key.encode()).hexdigest(), self.paths)
            process = running.process = self._spawn(running, command, running.launch_key)
            problem = self._wait_ready(running, process)
            if problem is None:
                self._set(running, Phase.READY)
                self.reporter.message(Level.SUCCESS, f"{app.title} ready")
                running.settled.set()
                while process.poll() is None and not running.stop.is_set() and not self.cancel.is_set():
                    time.sleep(POLL_SECONDS)
            if running.stop.is_set() or self.cancel.is_set():
                self._kill(process)
                return self._set(running, Phase.STOPPED)
            if running.reloading.is_set():
                running.reloading.clear()
                self._kill(process)
                self._set(running, Phase.STARTING, "Reloading.")
                continue
            status = process.poll()
            if problem is None and status == 0:
                return self._set(running, Phase.STOPPED, "It finished by itself.")
            why = problem or f"It stopped with status {status}."
            if app.restart != "on-failure":
                self._kill(process)
                raise AppStartError(f"{why} {tail(running.log)}".strip())
            if time.monotonic() - began > STABLE_AFTER_S:
                running.restarts = 0
            running.restarts += 1
            if running.restarts > MAX_RESTARTS:
                self._kill(process)
                raise AppStartError(f"Restarted {MAX_RESTARTS} times without staying up. {why}")
            self._kill(process)
            wait = RESTART_BACKOFF_S * 2 ** (running.restarts - 1)
            self._set(running, Phase.STARTING, f"Restart {running.restarts} of {MAX_RESTARTS} in {wait:.0f} s. {why}")
            self.reporter.message(Level.WARNING, f"{app.title} is being restarted", why)
            if running.stop.wait(wait):
                return self._set(running, Phase.STOPPED)
        self._set(running, Phase.STOPPED)

    def _wait_ready(self, running: Running, process: subprocess.Popen) -> str | None:
        """None once ready; otherwise why it is not going to be."""
        app = running.app
        deadline = time.monotonic() + app.timeout_s
        began = time.monotonic()
        configured = False
        while True:
            if running.stop.is_set() or self.cancel.is_set():
                return "It was stopped."
            status = process.poll()
            if status is not None:
                return f"It stopped with status {status} before it was ready. {tail(running.log)}".strip()
            if app.ready == "process":
                if time.monotonic() - began >= 1.0:
                    return None
            elif app.ready.startswith("delay:"):
                if time.monotonic() - began >= float(app.ready[6:]):
                    return None
            elif app.ready == "fabric":
                health = fabric.health(self.port, app.id, self.paths)
                if health:
                    if not configured:
                        self._configure(running)
                        configured = True
                    if health.get("state") == "active":
                        return None
                    if health.get("state") == "failed":
                        return f"It reported that it failed. {health.get('detail', '')}".strip()
            else:
                try:
                    with urllib.request.urlopen(app.ready, timeout=2) as response:
                        if response.status < 400:
                            return None
                except (urllib.error.URLError, OSError, ValueError):
                    pass
            if time.monotonic() > deadline:
                if app.ready == "fabric":
                    known = fabric.health(self.port, app.id, self.paths)
                    return (f"It registered but did not report itself active within {app.timeout_s:.0f} s." if known
                            else f"It did not register as {app.id} within {app.timeout_s:.0f} s. Is that the ID in its manifest?")
                return f"It was not ready within {app.timeout_s:.0f} s."
            time.sleep(POLL_SECONDS)

    def _configure(self, running: Running) -> None:
        """What this person already decided for it: its permissions, and its starting settings."""
        app = running.app
        if app.grants:
            described = fabric.describe(self.port, app.id, self.paths) or {}
            capability = described.get("capabilities") or {}
            wanted = sorted(set(capability.get("granted", [])) | (set(app.grants) & set(capability.get("requested", []))))
            response = fabric.grant(self.port, app.id, wanted, self.paths)
            if not response.ok:
                self.reporter.message(Level.WARNING, f"Could not give {app.title} its permissions", response.error_message())
        if app.settings:
            response = fabric.update_settings(self.port, app.id, app.settings, self.paths)
            if not response.ok:
                self.reporter.message(Level.WARNING, f"Could not set {app.title}'s settings", response.error_message())

    # -- stopping ----------------------------------------------------------------
    def _kill(self, process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=STOP_SECONDS)
        except subprocess.TimeoutExpired:
            LOG.warning("process group %s did not stop; killing it", process.pid)
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=STOP_SECONDS)
        except ProcessLookupError:
            pass

    def stop(self, app_id: str) -> None:
        running = self.running.get(app_id)
        if not running:
            return
        running.stop.set()
        if running.process:
            self._kill(running.process)
        if running.thread and running.thread is not threading.current_thread():
            running.thread.join(timeout=2)

    def stop_all(self) -> None:
        # First, so that an application's thread finishing late can't publish the plan again after it is cleared.
        published, self.publish_plan = self.publish_plan, False
        for app_id in list(self.running):
            self.stop(app_id)
        if published:
            fabric.set_plan(self.port, None, self.paths)
