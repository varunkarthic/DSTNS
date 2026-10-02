# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Diagnostics: every environment check, the terminal, the server and the paths."""
from __future__ import annotations

import platform
import sys

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Static

from ...core import api, environment, server
from ...core.environment import State
from ...core.paths import PATHS
from ...core.version import engine_version
from ..base import Page
from ..widgets import Key, Menu, MenuItem, Row, Rule, StatusTable


class DiagnosticsScreen(Page):
    TITLE_TEXT = "Diagnostics"
    KEYS = [Key("Enter", "Run", "Run", essential=True), Key("Esc", "Back", "Back", essential=True)]

    def compose_body(self) -> ComposeResult:
        with Horizontal(id="columns"):
            with Vertical(id="sidebar"):
                yield Menu([MenuItem("checks", "Run checks"), MenuItem("suites", "Include test suites"),
                            MenuItem("gpu", "GPU diagnostics")], id="actions")
            with VerticalScroll(id="content"):
                yield Static("ENVIRONMENT", classes="panel-title")
                yield Rule()
                yield StatusTable(id="checks", name_width=30)
                yield Static("", id="check-notes", classes="hint")
                yield Static("GPU", classes="section-title")
                yield Rule()
                yield StatusTable(id="gpu", name_width=30)
                yield Static("", id="gpu-notes", classes="hint")
                yield Static("SERVER", classes="section-title")
                yield Rule()
                yield StatusTable(id="server", name_width=20)
                yield Static("TERMINAL AND PATHS", classes="section-title")
                yield Rule()
                yield StatusTable(id="system", name_width=20)

    def on_mount(self) -> None:
        self.query_one("#actions", Menu).focus()
        caps = self.app.caps
        self.query_one("#system", StatusTable).set_rows([
            Row("Launcher", f"DSTNS {engine_version()} · Python {platform.python_version()}"),
            Row("Interface", f"Textual · layout {self.app.layout_class.value}"),
            Row("Terminal", f"{self.app.size.width} x {self.app.size.height} · colour {caps.colors.value} · "
                            f"{'Unicode' if caps.unicode else 'ASCII'}"),
            Row("TERM", caps.term or "unset"),
            Row("Repository", str(PATHS.root)),
            Row("Logs", str(PATHS.logs)),
            Row("Launcher log", str(PATHS.launcher_log)),
            Row("Interpreter", sys.executable),
        ])
        self.items = self.app.checks or environment.checks()
        self.redraw()
        if not self.app.checks:
            self.run(False)
        self.load_server()

    def on_menu_selected(self, event: Menu.Selected) -> None:
        if event.item.key == "gpu":
            self.query_one("#gpu", StatusTable).set_rows([Row("Vulkan", "Testing every device...", State.RUNNING)])
            self.probe_gpu()
            return
        self.run(event.item.key == "suites")

    @work(thread=True, exclusive=True, group="diagnostics-gpu")
    def probe_gpu(self) -> None:
        from ...core import compute, configuration

        try:
            config = configuration.load()
        except Exception:  # noqa: BLE001 - the environment checks report it
            config = {}
        result = compute.probe(config=config, refresh=True)
        rows = [Row("Policy", compute.policy(config)),
                Row("Loader", result.loader or "not found", State.PASS if result.loader else State.WARNING)]
        for d in result.devices:
            state = State.PASS if d.self_test else State.FAIL if d.self_test is False else State.SKIPPED
            value = f"{d.driver} · {d.type} · Vulkan {d.api}" + (" · in use" if d.selected else "")
            rows.append(Row(f"{d.index}  {d.name}", value, state, d.error or d.reason))
        notes = Text()
        if result.available:
            notes.append(f"\nGPU acceleration available: {result.headline()}. Each device above ran a real dispatch "
                         "and returned the expected answer.\n", style="#8CA7B2")
        else:
            notes.append(f"\nNo usable GPU ({result.reason or 'unavailable'}); the simulation runs on the CPU.\n", style="#F5B942")
            notes.append(compute.remedy(result) + "\n", style="#8CA7B2")
        def show() -> None:
            self.query_one("#gpu", StatusTable).set_rows(rows)
            self.query_one("#gpu-notes", Static).update(notes)
        self.app.call_from_thread(show)

    def run(self, suites: bool) -> None:
        self.items = environment.checks(suites=suites)
        self.header.set_state(State.RUNNING, "checking")
        self.redraw()
        self.execute()

    @work(thread=True, exclusive=True, group="diagnostics")
    def execute(self) -> None:
        environment.run_checks(self.items, on_update=lambda _c: self.app.call_from_thread(self.redraw))
        self.app.call_from_thread(self.finished)

    def redraw(self) -> None:
        rows = []
        for check in self.items:
            value = check.outcome.value or ("Checking..." if check.outcome.state is State.RUNNING else "")
            if check.seconds >= 1 and check.outcome.state not in (State.PENDING, State.RUNNING):
                value += f"  ({check.seconds:.1f} s)"
            rows.append(Row(check.name + ("" if check.required else " (optional)"), value, check.outcome.state,
                            check.outcome.remedy if check.outcome.state in (State.FAIL, State.WARNING) else ""))
        self.query_one("#checks", StatusTable).set_rows(rows)

    def finished(self) -> None:
        self.app.checks = [check for check in self.items if not check.slow] or self.app.checks
        blocking = environment.blocking(self.items)
        self.header.set_state(State.FAIL if blocking else State.PASS, "not ready" if blocking else "ready")
        notes = Text()
        for check in self.items:
            if check.outcome.state is State.FAIL and check.outcome.detail:
                notes.append(f"\n{check.name}\n", style="bold #F04444")
                notes.append(check.outcome.detail.strip()[-800:] + "\n", style="#8CA7B2")
        self.query_one("#check-notes", Static).update(notes)

    @work(thread=True, exclusive=True, group="diagnostics-server")
    def load_server(self) -> None:
        port = server.active_port()
        rows = []
        if port is None:
            rows.append(Row("Server", "not running", State.SKIPPED))
        else:
            info = api.call(port, "/api/v1/system/info", timeout=3)
            body = info.body if isinstance(info.body, dict) else {}
            sumo = body.get("sumo") or {}
            compute_info = body.get("compute") or {}
            device = compute_info.get("device") or {}
            rows += [Row("Server", f"port {port} · {body.get('lifecycle', '?').lower()}", State.PASS),
                     Row("Compute", f"{compute_info.get('active_backend', '?')}"
                                    + (f" · {device.get('name')}" if device.get("name") else "")
                                    + f" (requested {compute_info.get('requested_backend', '?')})"),
                     Row("Version", str(body.get("version", "?"))),
                     Row("Compiler", str((body.get("build") or {}).get("compiler", "?"))),
                     Row("SUMO", f"{'available' if sumo.get('available') else 'unavailable'} {sumo.get('version', '')}".strip(),
                         State.PASS if sumo.get("available") else State.SKIPPED)]
        self.app.call_from_thread(self.query_one("#server", StatusTable).set_rows, rows)
