# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Completion: the simulated day has ended."""
from __future__ import annotations

import threading

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Static

from ...core import simulation
from ...core.environment import State
from ...core.errors import DSTNSLauncherError
from ..base import Page
from ..widgets import Key, Menu, MenuItem, Row, Rule, StatusTable, symbol


class CompletionScreen(Page):
    TITLE_TEXT = "Simulation Completed"
    KEYS = [Key("Enter", "Select", "Select", essential=True), Key("Esc", "Dashboard", "Back", essential=True)]

    def __init__(self, *, world, status, port: int | None) -> None:
        super().__init__()
        self.world = world
        self.status_ = status
        self.port = port

    def compose_body(self) -> ComposeResult:
        with VerticalScroll(classes="body"):
            yield Static("", id="headline", classes="section-title")
            yield Rule()
            yield StatusTable(id="summary", name_width=18)
            yield Static(Text("\nThe observer holds the full report: choose Save Report there for the PDF.", style="#8CA7B2"),
                         classes="hint")
            yield Static("")
            yield Menu([
                MenuItem("observer", "Open the observer"),
                MenuItem("restart", "Restart the same day"),
                MenuItem("another", "Run another simulation"),
                MenuItem("menu", "Back to main menu"),
            ], id="actions")

    def on_mount(self) -> None:
        self.header.set_state(State.PASS, "completed")
        self.query_one("#headline", Static).update(Text.assemble(symbol(State.PASS), " SIMULATION COMPLETED"))
        rows = []
        if self.world:
            rows += [Row("Place", self.world.place), Row("Seed", self.world.seed), Row("Day", self.world.day_name),
                     Row("Road network", f"{self.world.nodes:,} junctions · {self.world.edges:,} road segments"),
                     Row("Places", f"{self.world.places:,}")]
        elif self.status_.seed:
            rows.append(Row("Seed", self.status_.seed))
        rows.append(Row("Simulation time", "24:00:00"))
        if self.status_.run_id:
            rows.append(Row("Run", self.status_.run_id))
        if self.port:
            rows.append(Row("Observer", f"http://127.0.0.1:{self.port}/"))
        self.query_one("#summary", StatusTable).set_rows(rows)
        self.query_one("#actions", Menu).focus()

    def on_menu_selected(self, event: Menu.Selected) -> None:
        key = event.item.key
        if key == "observer" and self.port:
            threading.Thread(target=simulation.open_in_browser, args=(f"http://127.0.0.1:{self.port}/",), daemon=True).start()
            self.notify("Opening the observer", timeout=3)
        elif key == "restart":
            self.restart()
        elif key == "another":
            from .start import StartScreen

            self.app.goto(StartScreen())
        elif key == "menu":
            self.app.pop_screen()

    @work(thread=True, exclusive=True)
    def restart(self) -> None:
        try:
            simulation.control(self.port, "restart")
        except DSTNSLauncherError as exc:
            self.app.call_from_thread(self.notify, str(exc), severity="error")
            return
        self.app.call_from_thread(self.resume)

    def resume(self) -> None:
        from .running import RunningScreen

        self.app.goto(RunningScreen(options=None))

    def action_back(self) -> None:
        self.app.pop_screen()
