# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Start simulation: choose what to run."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.widgets import Input, Select, Static, Switch

from ...core import configuration, simulation
from ...core.configuration import RunOptions
from ...core.errors import ConfigurationError
from ..base import Page
from ..widgets import FieldRow, Key, Menu, MenuItem, Rule

AUTO = "__auto__"
CUSTOM = "__custom__"


class StartScreen(Page):
    TITLE_TEXT = "Start Simulation"
    KEYS = [Key("Tab", "Next field", "Next", essential=True), Key("Ctrl+S", "Start", "Start", essential=True),
            Key("Esc", "Cancel", "Back", essential=True)]
    BINDINGS = Page.BINDINGS + [Binding("ctrl+s", "start", "Start", show=False, priority=True)]

    def compose_body(self) -> ComposeResult:
        try:
            defaults = configuration.load()
        except ConfigurationError:
            defaults = {"day": 0, "playback": {"tick_rate": 1}}
        maps = [("Chosen by the seed", AUTO)]
        maps += [(path, path) for path in simulation.cached_maps()]
        fixture = "data/fixtures/real_network.osm.xml"
        maps.append(("Bundled offline district", fixture))
        maps.append(("Another file...", CUSTOM))
        with VerticalScroll(classes="body"):
            yield Static("What to run", classes="section-title")
            yield Rule()
            yield FieldRow("Seed", Input(placeholder="empty: a new seed", id="seed", restrict=r"[0-9xXa-fA-F]*"),
                           id="row-seed")
            yield FieldRow("Day type", Select([("Weekday", "weekday"), ("Weekend", "weekend")], allow_blank=False,
                                              value="weekend" if defaults.get("day") == 1 else "weekday", id="day"),
                           id="row-day")
            yield FieldRow("Map", Select(maps, allow_blank=False, value=AUTO, id="map"), id="row-map")
            yield FieldRow("Map file", Input(placeholder="path to an OpenStreetMap XML file", id="map-file"), id="row-map-file")
            yield FieldRow("Speed", Input(str(defaults["playback"]["tick_rate"]), id="speed"), "x" if not self.app.unicode else "×",
                           id="row-speed")
            yield Static("Optional", classes="section-title")
            yield Rule()
            yield FieldRow("Save as", Input(placeholder="ID to save this configuration", id="save-as"), id="row-save")
            yield FieldRow("Description", Input(placeholder="a note stored with the saved seed", id="description"),
                           id="row-description")
            yield FieldRow("Open observer", Switch(value=bool(self.app.args.open), id="open"), id="row-open")
            yield Static("", id="form-error", classes="error-text")
            yield Menu([MenuItem("start", "Start simulation"), MenuItem("cancel", "Cancel")], id="actions")

    def on_mount(self) -> None:
        self.query_one("#row-map-file").display = False
        self.query_one("#seed", Input).focus()

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "map":
            self.query_one("#row-map-file").display = event.value == CUSTOM

    def on_input_submitted(self, _event: Input.Submitted) -> None:
        self.focus_next()

    def options(self) -> RunOptions | None:
        for row in self.query(FieldRow):
            row.set_problem("")
        self.query_one("#form-error", Static).update("")
        seed = self.query_one("#seed", Input).value.strip() or None
        map_choice = self.query_one("#map", Select).value
        osm_file = None
        if map_choice == CUSTOM:
            osm_file = self.query_one("#map-file", Input).value.strip() or None
            if not osm_file:
                self.query_one("#row-map-file", FieldRow).set_problem("Enter the path of a map file.")
                return None
        elif map_choice != AUTO:
            osm_file = str(map_choice)
        options = RunOptions(
            seed=seed,
            day_type=str(self.query_one("#day", Select).value),
            speed=self.query_one("#speed", Input).value.strip() or None,
            osm_file=osm_file,
            save_seed=self.query_one("#save-as", Input).value.strip() or None,
            description=self.query_one("#description", Input).value.strip() or None,
        )
        try:
            configuration.start_request(options)
        except ConfigurationError as exc:
            message = str(exc)
            target = ("row-seed" if "eed" in message and "saved" not in message.lower() else
                      "row-speed" if "speed" in message or "tick_rate" in message else
                      "row-map-file" if "OSM" in message or "map" in message.lower() else None)
            if target == "row-map-file":
                self.query_one("#row-map-file").display = True
            if target:
                self.query_one(f"#{target}", FieldRow).set_problem(message)
            else:
                self.query_one("#form-error", Static).update(message)
            return None
        if options.save_seed:
            import re

            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", options.save_seed):
                self.query_one("#row-save", FieldRow).set_problem(
                    "1 to 64 letters, digits, _ or -, starting with a letter or digit.")
                return None
        return options

    def on_menu_selected(self, event: Menu.Selected) -> None:
        if event.item.key == "start":
            self.action_start()
        else:
            self.app.pop_screen()

    def action_start(self) -> None:
        options = self.options()
        if options is None:
            return
        from .running import RunningScreen

        self.app.args.open = self.query_one("#open", Switch).value
        self.app.goto(RunningScreen(options=options))
