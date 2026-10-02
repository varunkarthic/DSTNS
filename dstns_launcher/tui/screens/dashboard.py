# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Dashboard: the launcher's home."""
from __future__ import annotations

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Static

from ...core import configuration, environment, server, simulation
from ...core import seeds as seed_store
from ...core.environment import State
from ...core.errors import DSTNSLauncherError
from ...core.paths import PATHS
from ...core.version import DOCUMENTATION, FULL_NAME, LICENSE_SPDX, OSM_ATTRIBUTION, engine_version
from ..base import Page
from ..widgets import Key, Menu, MenuItem, Row, Rule, StatusTable

ITEMS = [
    MenuItem("start", "Start simulation"),
    MenuItem("seeds", "Saved seeds"),
    MenuItem("config", "Configuration"),
    MenuItem("diagnostics", "Diagnostics"),
    MenuItem("logs", "Logs"),
    MenuItem("tests", "Tests"),
    MenuItem("tools", "Tools"),
    MenuItem("docs", "Documentation"),
    MenuItem("about", "About"),
    MenuItem("exit", "Exit"),
]


class DashboardScreen(Page):
    TITLE_TEXT = "Dashboard"
    KEYS = [Key("↑↓", "Navigate", "Move", essential=True), Key("Enter", "Select", "Select", essential=True),
            Key("q", "Quit", "Quit")]
    BINDINGS = Page.BINDINGS + [Binding("q", "app.request_quit", "Quit", show=False)]

    def __init__(self) -> None:
        super().__init__()
        self.server_port: int | None = None
        self.server_status: simulation.Status | None = None

    def compose_body(self) -> ComposeResult:
        with Horizontal(id="columns"):
            with Vertical(id="sidebar"):
                yield Menu(ITEMS, id="menu")
            with VerticalScroll(id="content"):
                yield Static("", id="panel-title", classes="panel-title")
                yield Rule()
                yield StatusTable(id="panel-rows", name_width=18)
                yield Static("", id="panel-text", classes="hint")

    def on_mount(self) -> None:
        if not self.app.unicode:
            self.set_keys([Key("Up/Down", "Navigate", "Move", essential=True), *self.KEYS[1:]])
        self.query_one("#menu", Menu).focus()
        self.update_header()
        self.poll()
        self.set_interval(2.0, self.poll)

    def on_screen_resume(self) -> None:
        self.refresh_menu()
        self.poll()
        self.show(self.query_one("#menu", Menu).current)

    # -- live state ---------------------------------------------------------------
    @work(thread=True, exclusive=True, group="dashboard-poll")
    def poll(self) -> None:
        port = self.app.session.port if self.app.session.handle and self.app.session.handle.running() else None
        port = port or server.active_port()
        current = simulation.status(port) if port else None
        self.app.call_from_thread(self.polled, port, current)

    def polled(self, port: int | None, current) -> None:
        if not self.is_mounted or not self.query("#menu"):
            return
        self.server_port = port
        self.server_status = current
        self.refresh_menu()
        self.update_header()
        menu = self.query_one("#menu", Menu)
        if menu.current and menu.current.key in {"start", "running"}:
            self.show(menu.current)

    def refresh_menu(self) -> None:
        menu = self.query_one("#menu", Menu)
        items = list(ITEMS)
        if self.server_status and self.server_status.reachable and self.server_status.lifecycle in {
                "RUNNING", "PAUSED", "SEEKING", "READY", "COMPLETED", "PREPARING"}:
            items.insert(0, MenuItem("running", "Running simulation"))
        if [item.key for item in items] != [item.key for item in menu.items]:
            menu.set_items(items)

    def update_header(self) -> None:
        checks = self.app.checks or []
        if self.server_status and self.server_status.reachable and self.server_status.lifecycle == "RUNNING":
            self.header.set_state(State.RUNNING, "running")
        elif environment.blocking(checks):
            self.header.set_state(State.FAIL, "not ready")
        elif any(check.outcome.state is State.WARNING for check in checks):
            self.header.set_state(State.WARNING, "ready")
        else:
            self.header.set_state(State.PASS, "ready")

    # -- detail panel ------------------------------------------------------------------
    def on_menu_highlighted(self, event: Menu.Highlighted) -> None:
        self.show(event.item)

    def show(self, item: MenuItem | None) -> None:
        if item is None:
            return
        title, rows, text = self.describe(item.key)
        self.query_one("#panel-title", Static).update(title.upper())
        self.query_one("#panel-rows", StatusTable).set_rows(rows)
        self.query_one("#panel-text", Static).update(text)

    def describe(self, key: str) -> tuple[str, list[Row], Text]:
        hint = Text(style="#8CA7B2")
        rows: list[Row] = []
        checks = {check.key: check for check in (self.app.checks or [])}

        def check_row(key: str, name: str) -> Row | None:
            check = checks.get(key)
            if not check:
                return None
            return Row(name, check.outcome.value, check.outcome.state)

        if key in {"start", "running"}:
            for check_key, name in (("configuration", "Configuration"), ("core", "Simulation core"),
                                    ("observer", "Observer"), ("cache", "Map cache"), ("sumo", "SUMO")):
                row = check_row(check_key, name)
                if row:
                    rows.append(row)
            current = self.server_status
            if current and current.reachable:
                rows.insert(0, Row("Server", f"port {self.server_port} · {current.lifecycle.lower()}", State.PASS))
                if current.active or current.lifecycle == "COMPLETED":
                    rows.insert(1, Row("Simulation time", f"{current.clock} ({current.fraction * 100:.0f}%)"))
                    if current.seed:
                        rows.insert(2, Row("Seed", current.seed))
            else:
                rows.insert(0, Row("Server", "not running", State.SKIPPED))
            rows.append(Row("Workspace", _relative(PATHS.logs)))
            if key == "running":
                hint.append("\nEnter shows the running simulation.")
                return "Running simulation", rows, hint
            hint.append("\nEnter chooses a seed and starts a simulation. The observer opens in your browser.")
            return "Start simulation", rows, hint
        if key == "seeds":
            try:
                saved = seed_store.operate("list", {})
            except DSTNSLauncherError as exc:
                return "Saved seeds", [Row("Store", str(exc), State.FAIL)], hint
            for record in saved[:6]:
                rows.append(Row(record["id"], record["seed"]))
            hint.append("\nNo saved seeds yet. Save one when starting a simulation." if not saved
                        else f"\n{len(saved)} saved. Enter lists them, to start, inspect or delete.")
            return "Saved seeds", rows, hint
        if key == "config":
            try:
                config = configuration.load()
                for field in configuration.FIELDS:
                    if field.category in {"Run", "Server"}:
                        rows.append(Row(field.label, f"{field.display(field.get(config))} {field.unit}".strip()))
                hint.append("\nEnter edits config/defaults.json.")
            except DSTNSLauncherError as exc:
                rows.append(Row("defaults.json", str(exc), State.FAIL))
            return "Configuration", rows, hint
        if key == "diagnostics":
            for check in (self.app.checks or []):
                if check.outcome.state in (State.FAIL, State.WARNING):
                    rows.append(Row(check.name, check.outcome.value, check.outcome.state))
            if not rows:
                rows.append(Row("Environment", "all checks passed", State.PASS))
            hint.append("\nEnter re-runs every check, optionally with the test suites, and shows terminal and server details.")
            return "Diagnostics", rows, hint
        if key == "logs":
            hint.append("\nThe server's system log, and its journal of API requests, operator events and lifecycle changes.")
            return "Logs", rows, hint
        if key == "tests":
            hint.append("\nRun the native, HTTP, reproducibility, SUMO and observer test stages.")
            return "Tests", rows, hint
        if key == "tools":
            hint.append("\nCheck the SUMO toolchain, rebuild the observer, or reset runtime data.")
            return "Tools", rows, hint
        if key == "docs":
            rows.append(Row("Online", DOCUMENTATION))
            hint.append("\nEnter opens the documentation in your browser.")
            return "Documentation", rows, hint
        if key == "about":
            copyright_text = "© 2026 Varun Karthic" if self.app.unicode else "(C) 2026 Varun Karthic"
            osm = OSM_ATTRIBUTION if self.app.unicode else "(C) OpenStreetMap contributors"
            rows += [Row("Version", engine_version()), Row("Copyright", copyright_text), Row("Licence", LICENSE_SPDX),
                     Row("Map data", osm)]
            hint.append(f"\n{FULL_NAME}.")
            return "About", rows, hint
        hint.append("\nLeave the launcher. A simulation this launcher started is stopped first, after confirmation.")
        return "Exit", rows, hint

    # -- actions -------------------------------------------------------------------------
    def on_menu_selected(self, event: Menu.Selected) -> None:
        key = event.item.key
        if key == "exit":
            self.app.action_request_quit()
            return
        if key == "docs":
            simulation.open_in_browser(DOCUMENTATION)
            self.notify(f"Opening {DOCUMENTATION}", timeout=3)
            return
        self.app.open(self.page_for(key))

    def page_for(self, key: str):
        if key == "running":
            from .running import RunningScreen

            return RunningScreen(options=None)
        if key == "start":
            from .start import StartScreen

            return StartScreen()
        if key == "seeds":
            from .seeds import SeedsScreen

            return SeedsScreen()
        if key == "config":
            from .configuration import ConfigurationScreen

            return ConfigurationScreen()
        if key == "diagnostics":
            from .diagnostics import DiagnosticsScreen

            return DiagnosticsScreen()
        if key == "logs":
            from .logs import LogsScreen

            return LogsScreen()
        if key == "tests":
            from .tasks import TestsScreen

            return TestsScreen()
        if key == "tools":
            from .tasks import ToolsScreen

            return ToolsScreen()
        from .about import AboutScreen

        return AboutScreen()

    def action_back(self) -> None:
        pass


def _relative(path) -> str:
    try:
        return "./" + str(path.relative_to(PATHS.root))
    except ValueError:
        return str(path)
