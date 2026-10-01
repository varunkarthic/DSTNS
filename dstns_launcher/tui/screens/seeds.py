# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Saved seeds: start, inspect or delete a saved configuration."""
from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Static

from ...core import seeds as seed_store
from ...core.configuration import RunOptions
from ...core.errors import DSTNSLauncherError
from ..base import Page, confirm
from ..widgets import Key, Menu, MenuItem, Row, Rule, StatusTable


class SeedsScreen(Page):
    TITLE_TEXT = "Saved Seeds"
    KEYS = [Key("Enter", "Start", "Start", essential=True), Key("d", "Delete", "Delete"), Key("Esc", "Back", "Back", essential=True)]
    BINDINGS = Page.BINDINGS + [Binding("d", "delete", "Delete", show=False), Binding("delete", "delete", "Delete", show=False)]

    def compose_body(self) -> ComposeResult:
        with Horizontal(id="columns"):
            with Vertical(id="sidebar"):
                yield Menu(id="seeds")
            with VerticalScroll(id="content"):
                yield Static("", id="seed-title", classes="panel-title")
                yield Rule()
                yield StatusTable(id="seed-detail", name_width=16)
                yield Static("", id="seed-hint", classes="hint")

    def on_mount(self) -> None:
        self.reload()
        self.query_one("#seeds", Menu).focus()

    def reload(self) -> None:
        try:
            self.records = seed_store.operate("list", {})
        except DSTNSLauncherError as exc:
            self.records = []
            self.query_one("#seed-hint", Static).update(Text(str(exc), style="#F04444"))
        menu = self.query_one("#seeds", Menu)
        menu.set_items([MenuItem(record["id"], record["id"]) for record in self.records])
        if not self.records:
            self.query_one("#seed-title", Static).update("NO SAVED SEEDS")
            self.query_one("#seed-detail", StatusTable).set_rows([])
            self.query_one("#seed-hint", Static).update(Text(
                "Save a configuration from Start simulation (Save as), or with\n./launcher start --seed N --save-seed ID",
                style="#8CA7B2"))

    def on_menu_highlighted(self, event: Menu.Highlighted) -> None:
        try:
            record = seed_store.operate("inspect", {"id": event.item.key})
        except DSTNSLauncherError as exc:
            self.query_one("#seed-hint", Static).update(Text(str(exc), style="#F04444"))
            return
        config = record["config"]
        osm = config.get("map", {}).get("osm_file", "auto")
        self.query_one("#seed-title", Static).update(record["id"].upper())
        self.query_one("#seed-detail", StatusTable).set_rows([
            Row("Seed", record["seed"]),
            Row("Day", "weekend" if config.get("day") == 1 else "weekday"),
            Row("Speed", f"{config.get('tick_rate', 1):g}x"),
            Row("Map", "chosen by the seed" if osm == "auto" else "pinned copy (verified on start)"),
            Row("Created", record["created_at"][:19].replace("T", " ") + " UTC"),
            Row("Description", record["description"] or "-"),
        ])
        self.query_one("#seed-hint", Static).update(Text("\nEnter starts this configuration; d deletes it.", style="#8CA7B2"))

    def on_menu_selected(self, event: Menu.Selected) -> None:
        from .running import RunningScreen

        self.app.goto(RunningScreen(options=RunOptions(saved_seed=event.item.key)))

    def action_delete(self) -> None:
        item = self.query_one("#seeds", Menu).current
        if item is None:
            return

        def decided(choice: str | None) -> None:
            if choice == "yes":
                try:
                    seed_store.operate("delete", {"id": item.key})
                    self.notify(f"Deleted {item.key}", timeout=3)
                except DSTNSLauncherError as exc:
                    self.notify(str(exc), severity="error")
                self.reload()

        self.app.push_screen(confirm("Delete saved seed?", f"Delete {item.key}? Map copies it used are kept.", "Delete"), decided)
