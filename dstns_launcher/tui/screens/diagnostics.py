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
                yield Menu([MenuItem("checks", "Run checks"), MenuItem("suites", "Include test suites")], id="actions")
            with VerticalScroll(id="content"):
                yield Static("ENVIRONMENT", classes="panel-title")
                yield Rule()
                yield StatusTable(id="checks", name_width=30)
                yield Static("", id="check-notes", classes="hint")
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
        self.run(event.item.key == "suites")

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
            rows += [Row("Server", f"port {port} · {body.get('lifecycle', '?').lower()}", State.PASS),
                     Row("Version", str(body.get("version", "?"))),
                     Row("Compiler", str((body.get("build") or {}).get("compiler", "?"))),
                     Row("SUMO", f"{'available' if sumo.get('available') else 'unavailable'} {sumo.get('version', '')}".strip(),
                         State.PASS if sumo.get("available") else State.SKIPPED)]
        self.app.call_from_thread(self.query_one("#server", StatusTable).set_rows, rows)
