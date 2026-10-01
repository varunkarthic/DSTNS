# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Environment check: real checks, shown as they complete."""
from __future__ import annotations

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.widgets import Static

from ...core import environment
from ...core.environment import Check, State
from ..base import Page
from ..widgets import Key, Menu, MenuItem, Row, Rule, StatusTable


class EnvironmentScreen(Page):
    TITLE_TEXT = "Environment Check"
    KEYS = [Key("Enter", "Select", "Select", essential=True), Key("r", "Retry", "Retry"), Key("q", "Quit", "Quit", essential=True)]
    BINDINGS = Page.BINDINGS + [Binding("r", "retry", "Retry", show=False), Binding("q", "app.request_quit", "Quit", show=False)]

    def __init__(self, *, config_problem=None) -> None:
        super().__init__()
        self.config_problem = config_problem
        self.items: list[Check] = []
        self.done = False

    def compose_body(self) -> ComposeResult:
        with VerticalScroll(classes="body"):
            yield Static("Required", classes="section-title")
            yield Rule()
            yield StatusTable(id="required", name_width=20)
            yield Static("Optional", classes="section-title")
            yield Rule()
            yield StatusTable(id="optional", name_width=20)
            yield Static("", id="summary", classes="hint")
            with Vertical(id="problems"):
                pass
            yield Menu(id="actions")

    def on_mount(self) -> None:
        self.header.set_state(State.RUNNING, "checking")
        self.query_one("#actions", Menu).display = False
        self.start_checks()

    def start_checks(self) -> None:
        self.done = False
        self.items = environment.checks()
        self.app.checks = self.items
        self.query_one("#actions", Menu).display = False
        self.query_one("#summary", Static).update("")
        self.redraw()
        self.run_checks()

    @work(thread=True, exclusive=True, group="checks")
    def run_checks(self) -> None:
        environment.run_checks(self.items, on_update=lambda _check: self.app.call_from_thread(self.redraw))
        self.app.call_from_thread(self.finished)

    def redraw(self) -> None:
        def rows(required: bool) -> list[Row]:
            out = []
            for check in self.items:
                if check.required != required:
                    continue
                state = check.outcome.state
                value = check.outcome.value or ("Checking..." if state is State.RUNNING else "")
                detail = check.outcome.remedy if state in (State.FAIL, State.WARNING) else ""
                out.append(Row(check.name, value, state, detail))
            return out

        self.query_one("#required", StatusTable).set_rows(rows(True))
        self.query_one("#optional", StatusTable).set_rows(rows(False))

    def finished(self) -> None:
        self.done = True
        blocking = environment.blocking(self.items)
        warnings = [c for c in self.items if c.outcome.state is State.WARNING]
        menu = self.query_one("#actions", Menu)
        if not blocking:
            self.header.set_state(State.PASS, "ready")
            # Nothing stops a run: continue straight on; warnings stay visible on the dashboard.
            self.app.after_environment()
            return
        self.header.set_state(State.FAIL, "not ready")
        summary = Text()
        summary.append(f"\n{len(blocking)} required check(s) failed. A simulation cannot start until they pass.\n",
                       style="#F04444")
        for check in blocking:
            summary.append(f"\n{check.name}: ", style="bold #E6F2F5")
            summary.append(check.outcome.value + "\n", style="#E6F2F5")
            if check.outcome.detail:
                summary.append(check.outcome.detail.strip()[:400] + "\n", style="#8CA7B2")
            if check.outcome.remedy:
                summary.append("Action: " + check.outcome.remedy + "\n", style="#8CA7B2")
        if warnings:
            summary.append(f"\n{len(warnings)} warning(s); see above.\n", style="#F5B942")
        self.query_one("#summary", Static).update(summary)
        menu.set_items([MenuItem("retry", "Retry"), MenuItem("diagnostics", "Diagnostics"),
                        MenuItem("continue", "Continue to the dashboard"), MenuItem("exit", "Exit")])
        menu.display = True
        menu.focus()

    def on_menu_selected(self, event: Menu.Selected) -> None:
        key = event.item.key
        if key == "retry":
            self.action_retry()
        elif key == "diagnostics":
            from .diagnostics import DiagnosticsScreen

            self.app.open(DiagnosticsScreen())
        elif key == "continue":
            self.app.after_environment()
        elif key == "exit":
            self.app.action_request_quit()

    def action_retry(self) -> None:
        if self.done:
            self.start_checks()

    def action_back(self) -> None:
        pass
