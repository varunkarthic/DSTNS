# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Configuration: edit ``config/defaults.json``."""
from __future__ import annotations

import copy

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Input, Select, Static, Switch

from ...core import configuration
from ...core.configuration import FIELDS, Field, Kind
from ...core.environment import State
from ...core.errors import ConfigurationError
from ..base import ChoiceDialog, Page
from ..widgets import FieldRow, Key, Menu, MenuItem, Rule


def _id(field: Field) -> str:
    return "field-" + field.key.replace(".", "-")


class ConfigurationScreen(Page):
    TITLE_TEXT = "Configuration"
    KEYS = [Key("↑↓", "Categories", "Move"), Key("Tab", "Next field", "Next", essential=True),
            Key("Ctrl+S", "Save", "Save", essential=True), Key("Esc", "Back", "Back", essential=True)]
    BINDINGS = Page.BINDINGS + [Binding("ctrl+s", "save", "Save", show=False, priority=True)]

    def __init__(self) -> None:
        super().__init__()
        self.config: dict = {}
        self.saved: dict = {}
        self.invalid: set[str] = set()
        self.load_error: str = ""

    @property
    def dirty(self) -> bool:
        return self.config != self.saved

    def compose_body(self) -> ComposeResult:
        try:
            self.saved = configuration.load()
        except ConfigurationError as exc:
            self.load_error = str(exc)
            self.saved = {}
        self.config = copy.deepcopy(self.saved)
        with Horizontal(id="columns"):
            with Vertical(id="sidebar"):
                yield Menu([MenuItem(category, category) for category in configuration.CATEGORIES], id="categories")
            with VerticalScroll(id="content"):
                yield Static("config/defaults.json", classes="dim")
                if self.load_error:
                    yield Static(Text(self.load_error, style="#F04444"), classes="hint")
                for category in configuration.CATEGORIES:
                    with Vertical(classes="category", id=f"category-{category.lower()}"):
                        yield Static(category, classes="section-title")
                        yield Rule()
                        for field in FIELDS:
                            if field.category == category:
                                yield FieldRow(field.label, self.editor(field), field.unit, id=_id(field))
                                yield Static(Text(field.help, style="#58717C"), classes="hint field-help hide-small")
                yield Static("", id="save-status", classes="hint")

    def editor(self, field: Field):
        value = field.get(self.config) if self.config else field.default
        if field.kind is Kind.BOOLEAN:
            return Switch(value=bool(value))
        if field.kind is Kind.CHOICE:
            return Select([(label.capitalize(), choice) for label, choice in field.choices], value=value, allow_blank=False)
        return Input(field.display(value), restrict=r"[0-9.\-]*" if field.kind in (Kind.INTEGER, Kind.NUMBER) else None)

    def on_mount(self) -> None:
        self.show_category(configuration.CATEGORIES[0])
        self.query_one("#categories", Menu).focus()
        self.update_state()

    def on_menu_highlighted(self, event: Menu.Highlighted) -> None:
        self.show_category(event.item.key)

    def on_menu_selected(self, event: Menu.Selected) -> None:
        self.show_category(event.item.key)
        rows = [row for row in self.query(FieldRow) if row.parent.display]
        if rows:
            rows[0].editor.focus()

    def show_category(self, name: str) -> None:
        for section in self.query(".category"):
            section.display = section.id == f"category-{name.lower()}"

    def field_for(self, widget) -> Field | None:
        node = widget
        while node is not None and not isinstance(node, FieldRow):
            node = node.parent
        if node is None:
            return None
        return next((field for field in FIELDS if _id(field) == node.id), None)

    def apply(self, widget, value, text: str | None = None) -> None:
        field = self.field_for(widget)
        if field is None:
            return
        row = self.query_one(f"#{_id(field)}", FieldRow)
        try:
            parsed = field.parse(text) if text is not None else value
            problem = configuration.check_field(field, parsed, self.config)
            if problem:
                raise ConfigurationError(problem)
        except ConfigurationError as exc:
            self.invalid.add(field.key)
            row.set_problem(str(exc))
            widget.set_class(True, "-invalid")
            self.update_state()
            return
        self.invalid.discard(field.key)
        row.set_problem("")
        widget.set_class(False, "-invalid")
        field.set(self.config, parsed)
        self.update_state()

    def on_input_changed(self, event: Input.Changed) -> None:
        self.apply(event.input, None, event.value)

    def on_input_submitted(self, _event: Input.Submitted) -> None:
        self.focus_next()

    def on_switch_changed(self, event: Switch.Changed) -> None:
        self.apply(event.switch, event.value)

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.value is not Select.NULL:
            self.apply(event.select, event.value)

    def update_state(self) -> None:
        status = self.query_one("#save-status", Static)
        if self.invalid:
            self.header.set_state(State.FAIL, f"{len(self.invalid)} invalid")
            status.update(Text("\nCorrect the highlighted values before saving.", style="#F04444"))
        elif self.dirty:
            self.header.set_state(State.WARNING, "unsaved")
            status.update(Text("\nUnsaved changes. Ctrl+S saves them to config/defaults.json.", style="#F5B942"))
        else:
            self.header.set_state(State.PASS, "saved")
            status.update("")

    def action_save(self) -> bool:
        if self.invalid:
            self.notify("Correct the invalid values first.", severity="error", timeout=4)
            return False
        if self.load_error:
            self.notify("The configuration file could not be read, so it is not overwritten.", severity="error")
            return False
        try:
            configuration.save(self.config)
        except ConfigurationError as exc:
            self.notify(str(exc), severity="error", timeout=6)
            return False
        self.saved = copy.deepcopy(self.config)
        self.update_state()
        self.notify("Configuration saved.", timeout=3)
        return True

    def action_back(self) -> None:
        if not self.dirty and not self.invalid:
            self.app.pop_screen()
            return

        def decided(choice: str | None) -> None:
            if choice == "save" and self.action_save():
                self.app.pop_screen()
            elif choice == "discard":
                self.app.pop_screen()

        self.app.push_screen(ChoiceDialog("Unsaved Changes", "Configuration has been modified.",
                                          [("save", "Save and continue"), ("discard", "Discard changes"), ("cancel", "Cancel")],
                                          cancel="cancel"), decided)
