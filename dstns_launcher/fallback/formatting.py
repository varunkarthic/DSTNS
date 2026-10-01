# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Line-oriented output for compatibility mode and for scripted commands.

Two back ends with one interface: Rich when it is installed, and plain
``print``/``input`` otherwise. Meaning is always carried by words and markers
such as ``[OK]``; colour, when available, only reinforces it.
"""
from __future__ import annotations

import sys
import time
from typing import Any, Iterable, Sequence

from ..core.environment import State
from ..core.reporting import Level, Reporter
from ..core.terminal import Capabilities, Colors

MARK = {
    State.PASS: "[OK]", State.WARNING: "[WARN]", State.FAIL: "[ERROR]", State.SKIPPED: "[SKIP]",
    State.RUNNING: "[....]", State.PENDING: "[    ]",
}
LEVEL_MARK = {Level.INFO: "[INFO]", Level.SUCCESS: "[OK]", Level.WARNING: "[WARN]", Level.ERROR: "[ERROR]"}
TONE = {"heading": "36;1", "ok": "32", "warn": "33", "error": "31", "muted": "90", "accent": "36"}
STATE_TONE = {State.PASS: "ok", State.WARNING: "warn", State.FAIL: "error", State.SKIPPED: "muted",
              State.RUNNING: "accent", State.PENDING: "muted"}
LEVEL_TONE = {Level.INFO: "accent", Level.SUCCESS: "ok", Level.WARNING: "warn", Level.ERROR: "error"}
WIDTH = 60


class Output:
    """Plain text, with ANSI colour when the terminal supports it."""

    def __init__(self, caps: Capabilities, stream=None) -> None:
        self.caps = caps
        self.stream = stream or sys.stdout
        self.color = caps.colors is not Colors.NONE
        self.width = max(40, min(WIDTH, caps.width - 2))

    # -- primitives -------------------------------------------------------
    def paint(self, text: str, tone: str | None) -> str:
        if not self.color or not tone:
            return text
        return f"\x1b[{TONE[tone]}m{text}\x1b[0m"

    def esc(self, text: str) -> str:
        """Make arbitrary text safe to pass to :meth:`write`."""
        return text

    def write(self, text: str = "") -> None:
        print(text, file=self.stream, flush=True)

    def rule(self, char: str = "-") -> None:
        self.write(" " + self.paint(char * (self.width - 1), "muted"))

    def banner(self, title: str, subtitle: str = "") -> None:
        self.write(self.paint("=" * self.width, "muted"))
        self.write(" " + self.paint(title, "heading"))
        if subtitle:
            self.write(" " + self.esc(subtitle))
        self.write(self.paint("=" * self.width, "muted"))

    def heading(self, text: str) -> None:
        self.write()
        self.write(" " + self.paint(text, "heading"))

    def line(self, text: str, tone: str | None = None) -> None:
        self.write(" " + self.paint(text, tone))

    def muted(self, text: str) -> None:
        self.line(text, "muted")

    def status(self, state: State, name: str, value: str = "", width: int = 22) -> None:
        mark = MARK[state].ljust(7)
        self.write(f" {self.paint(mark, STATE_TONE[state])} {self.esc(name.ljust(width))} {self.esc(value)}".rstrip())

    def message(self, level: Level, text: str, detail: str = "") -> None:
        mark = self.paint(LEVEL_MARK[level].ljust(7), LEVEL_TONE[level])
        suffix = f"  {self.paint(detail, 'muted')}" if detail else ""
        self.write(f" {mark} {self.esc(text)}{suffix}")

    def table(self, columns: Sequence[str], rows: Iterable[Sequence[Any]], max_width: int = 48) -> None:
        cells = [[_fit(str(value), max_width) for value in row] for row in rows]
        widths = [len(column) for column in columns]
        for row in cells:
            for index, value in enumerate(row):
                widths[index] = max(widths[index], len(value))
        self.write(" " + self.paint("  ".join(c.ljust(w) for c, w in zip(columns, widths)), "heading"))
        for row in cells:
            self.write(" " + self.esc("  ".join(value.ljust(width) for value, width in zip(row, widths)).rstrip()))

    def pairs(self, rows: Iterable[tuple[str, Any]], width: int = 20) -> None:
        for key, value in rows:
            self.write(f" {self.paint(key.ljust(width), 'muted')} {self.esc(str(value))}")

    def menu(self, items: Sequence[str], selected: int | None = None) -> None:
        for index, label in enumerate(items, start=1):
            pointer = ">" if selected == index - 1 else " "
            self.write(f" {pointer} {index}. {self.esc(label)}")

    # -- input --------------------------------------------------------------
    def ask(self, prompt: str, default: str = "") -> str:
        suffix = f" [{default}]" if default else ""
        try:
            answer = input(f" {prompt}{suffix}: ")
        except EOFError:
            raise
        return answer.strip() or default

    def confirm(self, prompt: str, default: bool = False) -> bool:
        hint = "[Y/n]" if default else "[y/N]"
        answer = input(f" {prompt} {hint} ").strip().lower()
        return default if not answer else answer in {"y", "yes"}


class RichOutput(Output):
    """The same interface rendered with Rich: styled, but still marker-based."""

    def __init__(self, caps: Capabilities, stream=None) -> None:
        super().__init__(caps, stream)
        from rich.console import Console

        system = {Colors.TRUECOLOR: "truecolor", Colors.EXTENDED: "256", Colors.STANDARD: "standard"}.get(caps.colors)
        self.console = Console(file=self.stream, color_system=system, no_color=system is None,
                               highlight=False, emoji=False, width=max(40, caps.width), soft_wrap=False)

    STYLE = {"heading": "bold #22D3E6", "ok": "#32D583", "warn": "#F5B942", "error": "#F04444",
             "muted": "#8CA7B2", "accent": "#22D3E6"}

    def paint(self, text: str, tone: str | None) -> str:
        from rich.markup import escape

        return f"[{self.STYLE[tone]}]{escape(text)}[/]" if tone else escape(text)

    def esc(self, text: str) -> str:
        from rich.markup import escape

        return escape(text)

    def write(self, text: str = "") -> None:
        self.console.print(text, overflow="fold")

    def line(self, text: str, tone: str | None = None) -> None:
        self.write(" " + self.paint(text, tone))

    def table(self, columns: Sequence[str], rows: Iterable[Sequence[Any]], max_width: int = 48) -> None:
        from rich.table import Table
        from rich import box

        table = Table(box=box.SIMPLE_HEAD, header_style=self.STYLE["heading"], pad_edge=False, show_edge=False)
        for column in columns:
            table.add_column(column, overflow="ellipsis", max_width=max_width)
        from rich.text import Text

        for row in rows:
            table.add_row(*[Text(" ".join(str(value).split())) for value in row])
        self.console.print(table)

    def ask(self, prompt: str, default: str = "") -> str:
        from rich.prompt import Prompt

        return Prompt.ask(f" {prompt}", default=default or None, console=self.console, show_default=bool(default)) or ""

    def confirm(self, prompt: str, default: bool = False) -> bool:
        from rich.prompt import Confirm

        return Confirm.ask(f" {prompt}", default=default, console=self.console)


def make_output(caps: Capabilities, *, rich: bool = True, stream=None) -> Output:
    """Rich if requested and installed, else plain."""
    if rich:
        try:
            return RichOutput(caps, stream)
        except ImportError:
            pass
    return Output(caps, stream)


class LineReporter(Reporter):
    """Prints operations as they happen, one line at a time.

    Progress is redrawn in place only on an interactive terminal; elsewhere it is
    printed at most every few seconds, so logs and pipes stay readable.
    """

    def __init__(self, out: Output, *, verbose: bool = False) -> None:
        self.out = out
        self.verbose = verbose
        self.redraw = out.caps.interactive and out.stream.isatty() if hasattr(out.stream, "isatty") else False
        self._last_progress = 0.0
        self._drew = False

    def message(self, level: Level, text: str, detail: str = "") -> None:
        super().message(level, text, detail)
        self._clear()
        self.out.message(level, text, detail)

    def step_started(self, title: str) -> None:
        super().step_started(title)
        self._clear()
        self.out.status(State.RUNNING, title, width=36)

    def step_output(self, title: str, line: str) -> None:
        super().step_output(title, line)
        if self.verbose:
            self.out.muted("    " + line)

    def step_finished(self, title: str, ok: bool, summary: str) -> None:
        super().step_finished(title, ok, summary)
        self._clear()
        self.out.status(State.PASS if ok else State.FAIL, title, summary, width=36)

    def progress(self, label: str, done: float, total: float | None) -> None:
        now = time.monotonic()
        if total:
            text = f"{label}: {done / total * 100:3.0f}%  {done / 1048576:.1f}/{total / 1048576:.1f} MiB"
        elif done:
            text = f"{label}: {done / 1048576:.1f} MiB"
        else:
            text = f"{label}…" if self.out.caps.unicode else f"{label}..."
        if self.redraw:
            print("\r " + text[: self.out.width - 2].ljust(self.out.width - 2), end="", file=self.out.stream, flush=True)
            self._drew = True
        elif now - self._last_progress >= 5:
            self._last_progress = now
            self.out.muted(text)

    def progress_done(self) -> None:
        self._clear()

    def _clear(self) -> None:
        if self._drew:
            print("\r" + " " * self.out.width + "\r", end="", file=self.out.stream, flush=True)
            self._drew = False


def _fit(text: str, width: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= width else text[: width - 3] + "..."
