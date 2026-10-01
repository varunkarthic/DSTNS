# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The few widgets the launcher is built from.

Every one renders its meaning in text: the selected menu item carries ``>``,
a status carries a symbol and a word, the focused form field carries a marker.
Colour only reinforces what is already readable in monochrome.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from rich.table import Table
from rich.text import Text
from textual import events
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Static

from ..core.environment import MARKERS, State

LOGO = (Path(__file__).resolve().parent.parent / "assets" / "logo.txt").read_text(encoding="utf-8").rstrip("\n")
LOGO_WIDTH = max(len(line) for line in LOGO.splitlines())

CYAN, TEXT, TEXT2, MUTED = "#22D3E6", "#E6F2F5", "#8CA7B2", "#58717C"
TONES = {State.PASS: "#32D583", State.WARNING: "#F5B942", State.FAIL: "#F04444", State.SKIPPED: MUTED,
         State.RUNNING: CYAN, State.PENDING: MUTED}


def unicode_ok() -> bool:
    app = _app()
    return getattr(app, "unicode", True)


def _app():
    from textual._context import active_app

    try:
        return active_app.get()
    except LookupError:
        return None


def mark(state: State) -> Text:
    """``✓ OK``-style marker: a symbol and a word, styled."""
    symbol_unicode, symbol_ascii, word = MARKERS[state]
    symbol = symbol_unicode if unicode_ok() else symbol_ascii
    return Text(f"{symbol} {word}", style=TONES[state])


def symbol(state: State) -> Text:
    symbol_unicode, symbol_ascii, _ = MARKERS[state]
    return Text(symbol_unicode if unicode_ok() else symbol_ascii, style=TONES[state])


class Wordmark(Static):
    """The DSTNS wordmark; plain ``DSTNS`` where it would not fit."""

    def __init__(self, **kwargs) -> None:
        super().__init__("", **kwargs)

    def on_mount(self) -> None:
        self._draw()

    def on_resize(self, event: events.Resize) -> None:
        self._draw()

    def _draw(self) -> None:
        available = self.app.size.width - 4
        if unicode_ok() and available >= LOGO_WIDTH and self.app.size.height >= 22:
            self.update(Text(LOGO, style=CYAN))
        else:
            self.update(Text("D S T N S", style=f"bold {CYAN}"))


class Rule(Static):
    """A thin horizontal separator, optionally titled."""

    def __init__(self, title: str = "", **kwargs) -> None:
        super().__init__("", classes="rule", **kwargs)
        self.title_text = title

    def render(self) -> Text:
        width = max(1, self.size.width)
        char = "─" if unicode_ok() else "-"
        if not self.title_text:
            return Text(char * width, style="#0B3C5D")
        label = f" {self.title_text} "
        left = max(2, (width - len(label)) // 2)
        right = max(0, width - left - len(label))
        line = Text(char * left, style="#0B3C5D")
        line.append(label, style=TEXT2)
        line.append(char * right, style="#0B3C5D")
        return line


class HeaderBar(Static):
    """``DSTNS 2.1.0 · Screen`` on the left, a state marker and word on the right."""

    def __init__(self, title: str, **kwargs) -> None:
        super().__init__("", **kwargs)
        self.title_text = title
        self.state: tuple[State, str] | None = None

    def set_state(self, state: State, word: str) -> None:
        self.state = (state, word)
        self.refresh()

    def render(self) -> Text:
        from ..core.version import engine_version

        width = max(10, self.size.width)
        left = Text()
        left.append("DSTNS", style=f"bold {CYAN}")
        left.append(f" {engine_version()}", style=TEXT2)
        if self.title_text and width >= 50:
            left.append("  ·  " if unicode_ok() else "  -  ", style=MUTED)
            left.append(self.title_text, style=TEXT)
        right = Text()
        if self.state:
            state, word = self.state
            right.append_text(symbol(state))
            right.append(f" {word.upper()}", style=TONES[state])
        gap = max(1, width - left.cell_len - right.cell_len)
        if left.cell_len + right.cell_len >= width:
            left.truncate(max(5, width - right.cell_len - 1), overflow="ellipsis")
            gap = 1
        return Text.assemble(left, " " * gap, right)


@dataclass(frozen=True)
class Key:
    key: str
    label: str
    short: str = ""
    essential: bool = False


class KeyBar(Static):
    """Shortcuts for the current screen, shortened to fit the terminal."""

    def __init__(self, keys: Sequence[Key] = (), **kwargs) -> None:
        super().__init__("", **kwargs)
        self.keys = list(keys)

    def set_keys(self, keys: Sequence[Key]) -> None:
        self.keys = list(keys)
        self.refresh()

    def render(self) -> Text:
        width = max(10, self.size.width)
        variants = (
            [(key, key.label) for key in self.keys],
            [(key, key.short or key.label) for key in self.keys],
            [(key, key.short or key.label) for key in self.keys if key.essential],
            [(key, "") for key in self.keys if key.essential],
        )
        text = Text()
        for variant in variants:
            text = Text(no_wrap=True, overflow="ellipsis")
            for key, label in variant:
                if text.cell_len:
                    text.append("   ")
                text.append(key.key, style=f"bold {CYAN}")
                if label:
                    text.append(f" {label}", style=TEXT2)
            if text.cell_len <= width:
                return text
        text.truncate(width, overflow="ellipsis")
        return text


@dataclass
class MenuItem:
    key: str
    label: str
    hint: str = ""
    disabled: bool = False


class Menu(Widget, can_focus=True):
    """A vertical list with a ``>`` marker on the selected item.

    Arrow keys, j/k, Home and End move; Enter activates. Mouse clicks work too,
    but nothing requires them.
    """

    BINDINGS = [
        Binding("up", "move(-1)", "Previous", show=False),
        Binding("k", "move(-1)", "Previous", show=False),
        Binding("down", "move(1)", "Next", show=False),
        Binding("j", "move(1)", "Next", show=False),
        Binding("home", "jump(0)", "First", show=False),
        Binding("end", "jump(-1)", "Last", show=False),
        Binding("enter", "activate", "Select", show=False),
    ]

    index: reactive[int] = reactive(0)

    class Highlighted(Message):
        def __init__(self, menu: "Menu", item: MenuItem) -> None:
            super().__init__()
            self.menu = menu
            self.item = item

    class Selected(Message):
        def __init__(self, menu: "Menu", item: MenuItem) -> None:
            super().__init__()
            self.menu = menu
            self.item = item

    def __init__(self, items: Iterable[MenuItem] = (), *, show_hints: bool = False, **kwargs) -> None:
        super().__init__(**kwargs)
        self.items: list[MenuItem] = list(items)
        self.show_hints = show_hints

    @property
    def current(self) -> MenuItem | None:
        return self.items[self.index] if self.items and 0 <= self.index < len(self.items) else None

    def set_items(self, items: Iterable[MenuItem], *, keep: str | None = None) -> None:
        current = keep if keep is not None else (self.current.key if self.current else None)
        self.items = list(items)
        keys = [item.key for item in self.items]
        self.index = keys.index(current) if current in keys else min(self.index, max(0, len(self.items) - 1))
        self.refresh(layout=True)
        if self.current:
            self.post_message(self.Highlighted(self, self.current))

    def select_key(self, key: str) -> None:
        keys = [item.key for item in self.items]
        if key in keys:
            self.index = keys.index(key)

    def get_content_height(self, container, viewport, width: int) -> int:
        lines = len(self.items)
        if self.show_hints:
            lines += sum(1 for item in self.items if item.hint)
        return max(1, lines)

    def watch_index(self, old: int, new: int) -> None:
        self.refresh()
        if self.current and old != new:
            self.post_message(self.Highlighted(self, self.current))

    def on_mount(self) -> None:
        if self.current:
            self.post_message(self.Highlighted(self, self.current))

    def on_focus(self) -> None:
        self.refresh()

    def on_blur(self) -> None:
        self.refresh()

    def render(self) -> Text:
        width = max(4, self.size.width)
        text = Text(no_wrap=True, overflow="ellipsis")
        for position, item in enumerate(self.items):
            selected = position == self.index
            pointer = "> " if selected else "  "
            label = item.label
            if len(label) + 2 > width:
                label = label[: max(1, width - 3)] + ("…" if unicode_ok() else ".")
            line = f"{pointer}{label}".ljust(width)
            if item.disabled:
                style = MUTED
            elif selected and self.has_focus:
                style = f"bold #050A0E on {CYAN}"
            elif selected:
                style = f"bold {CYAN}"
            else:
                style = TEXT
            if position:
                text.append("\n")
            text.append(line, style=style)
            if self.show_hints and item.hint:
                hint = f"    {item.hint}"
                text.append("\n" + hint[:width].ljust(width), style=MUTED)
        return text

    def action_move(self, step: int) -> None:
        if not self.items:
            return
        position = self.index
        for _ in range(len(self.items)):
            position = max(0, min(len(self.items) - 1, position + step))
            if not self.items[position].disabled or position in (0, len(self.items) - 1):
                break
        self.index = position

    def action_jump(self, position: int) -> None:
        if self.items:
            self.index = position % len(self.items)

    def action_activate(self) -> None:
        if self.current and not self.current.disabled:
            self.post_message(self.Selected(self, self.current))

    def on_click(self, event: events.Click) -> None:
        line = event.y
        position = 0
        for index, item in enumerate(self.items):
            height = 2 if self.show_hints and item.hint else 1
            if position <= line < position + height:
                self.index = index
                self.action_activate()
                return
            position += height


@dataclass
class Row:
    """One line of a status table: state, name, value, and optional detail."""

    name: str
    value: str = ""
    state: State | None = None
    detail: str = ""


class StatusTable(Static):
    """Aligned rows: marker, name, value. Columns never push past the widget's width."""

    def __init__(self, rows: Sequence[Row] = (), *, name_width: int = 20, **kwargs) -> None:
        super().__init__("", **kwargs)
        self.rows = list(rows)
        self.name_width = name_width

    def set_rows(self, rows: Sequence[Row]) -> None:
        self.rows = list(rows)
        self.refresh(layout=True)

    def render(self) -> Table:
        width = max(20, self.size.width)
        table = Table.grid(padding=(0, 2), expand=False)
        narrow = width < 56
        table.add_column(no_wrap=True, width=min(self.name_width, max(10, width // 3)), overflow="ellipsis")
        table.add_column(no_wrap=True, overflow="ellipsis", ratio=1)
        if not narrow:
            table.add_column(no_wrap=True, width=12)
        for row in self.rows:
            name = Text(row.name, style=TEXT2)
            value = Text(row.value, style=TEXT)
            if narrow and row.state is not None:
                value = Text.assemble(symbol(row.state), " ", value)
            cells = [name, value]
            if not narrow:
                cells.append(mark(row.state) if row.state is not None else Text(""))
            table.add_row(*cells)
            if row.detail:
                table.add_row(Text(""), Text(row.detail, style=MUTED), *([Text("")] if not narrow else []))
        table.width = width
        return table


class FieldRow(Widget):
    """A labelled form field. A marker shows which field has focus."""

    DEFAULT_CSS = "FieldRow { height: auto; }"

    def __init__(self, label: str, editor: Widget, unit: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self.label_text = label
        self.editor = editor
        self.unit_text = unit

    def compose(self) -> ComposeResult:
        with Horizontal(classes="field-line"):
            yield Static("  " + self.label_text, classes="label")
            with Vertical(classes="editor"):
                yield self.editor
            if self.unit_text:
                yield Static(self.unit_text, classes="unit")
        yield Static("", classes="problem")

    def on_descendant_focus(self, _event) -> None:
        # The marker is text, so the focused field is visible without colour.
        self.query_one(".label", Static).update(Text("> " + self.label_text, style=f"bold {CYAN}"))

    def on_descendant_blur(self, _event) -> None:
        self.query_one(".label", Static).update("  " + self.label_text)

    def set_problem(self, text: str) -> None:
        cross = "✗" if unicode_ok() else "x"
        self.query_one(".problem", Static).update(f"{cross} {text}" if text else "")
