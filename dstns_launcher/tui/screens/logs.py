# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Logs: the server's system log and its SQLite journal."""
from __future__ import annotations

from rich.table import Table
from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import RichLog, Static

from ...core import logs
from ..base import Page
from ..widgets import Key, Menu, MenuItem


class LogsScreen(Page):
    TITLE_TEXT = "Logs"
    KEYS = [Key("↑↓", "Source", "Source"), Key("r", "Refresh", "Refresh", essential=True),
            Key("PgUp/PgDn", "Scroll", "Scroll"), Key("Esc", "Back", "Back", essential=True)]
    BINDINGS = Page.BINDINGS + [Binding("r", "refresh", "Refresh", show=False)]

    def compose_body(self) -> ComposeResult:
        with Horizontal(id="columns"):
            with Vertical(id="sidebar"):
                yield Menu([MenuItem(key, label) for key, label in logs.SOURCES.items()], id="sources")
            with Vertical(id="content"):
                yield Static("", id="source-title", classes="panel-title")
                yield RichLog(id="log-view", min_width=10, wrap=True, max_lines=5000)

    def on_mount(self) -> None:
        self.query_one("#sources", Menu).focus()

    def on_menu_highlighted(self, event: Menu.Highlighted) -> None:
        self.load(event.item.key)

    def on_menu_selected(self, _event: Menu.Selected) -> None:
        self.query_one("#log-view", RichLog).focus()

    def action_refresh(self) -> None:
        item = self.query_one("#sources", Menu).current
        if item:
            self.load(item.key)

    @work(thread=True, exclusive=True)
    def load(self, key: str) -> None:
        if key == "system":
            lines = logs.system_tail(500)
            self.app.call_from_thread(self.show_lines, key, lines)
        else:
            table = logs.journal(key, 200)
            self.app.call_from_thread(self.show_table, key, table)

    def show_lines(self, key: str, lines) -> None:
        view = self.query_one("#log-view", RichLog)
        view.clear()
        self.query_one("#source-title", Static).update(logs.SOURCES[key].upper() + "  ·  logs/system.log")
        if lines is None:
            view.write(Text("No system log yet. It is created when the server first starts.", style="#8CA7B2"))
            return
        for line in lines:
            style = "#F04444" if "[ERROR]" in line else "#F5B942" if "[WARN" in line else "#E6F2F5"
            view.write(Text(line, style=style))

    def show_table(self, key: str, table) -> None:
        view = self.query_one("#log-view", RichLog)
        view.clear()
        self.query_one("#source-title", Static).update(logs.SOURCES[key].upper() + "  ·  logs/runtime.db")
        if table is None:
            view.write(Text("No runtime database yet. It is created when the server first starts.", style="#8CA7B2"))
            return
        if not table.rows:
            view.write(Text("No records yet.", style="#8CA7B2"))
            return
        grid = Table(show_edge=False, header_style="bold #22D3E6", box=None, pad_edge=False)
        for column in table.columns:
            grid.add_column(column, overflow="ellipsis", no_wrap=True, max_width=48)
        for row in table.rows:
            grid.add_row(*[Text("" if value is None else str(value)) for value in row])
        view.write(grid)
