# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Page frame, dialogs and the bridge from worker threads to the screen."""
from __future__ import annotations

import threading
import time
from typing import Callable, Sequence

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen, Screen
from textual.widgets import Static

from ..core.errors import DSTNSLauncherError
from ..core.paths import PATHS
from ..core.reporting import Level, Reporter
from .widgets import HeaderBar, Key, KeyBar, Menu, MenuItem

GLOBAL_KEYS = [Key("?", "Help", "Help")]


class Page(Screen):
    """A full screen: header, a body the subclass composes, and the key bar."""

    TITLE_TEXT = ""
    KEYS: Sequence[Key] = ()

    BINDINGS = [
        Binding("escape", "back", "Back", show=False),
        Binding("question_mark", "help", "Help", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield HeaderBar(self.TITLE_TEXT, id="header")
        yield from self.compose_body()
        yield KeyBar(list(self.KEYS) + GLOBAL_KEYS, id="keys")

    def compose_body(self) -> ComposeResult:
        yield Static("")

    @property
    def header(self) -> HeaderBar:
        return self.query_one("#header", HeaderBar)

    def set_keys(self, keys: Sequence[Key]) -> None:
        self.query_one("#keys", KeyBar).set_keys(list(keys) + GLOBAL_KEYS)

    def action_back(self) -> None:
        if len(self.app.screen_stack) > 2:
            self.app.pop_screen()

    def action_help(self) -> None:
        self.app.push_screen(HelpDialog(self.help_lines()))

    def help_lines(self) -> list[tuple[str, str]]:
        lines = [(key.key, key.label) for key in self.KEYS]
        lines += [("Up/Down, j/k", "Move"), ("Enter", "Select"), ("Tab, Shift+Tab", "Next or previous control"),
                  ("Esc", "Back or dismiss"), ("Ctrl+C", "Quit safely"), ("?", "This help")]
        return lines


class ChoiceDialog(ModalScreen[str]):
    """A message and a list of actions; returns the chosen action's key."""

    BINDINGS = [Binding("escape", "cancel", "Cancel", show=False)]

    def __init__(self, title: str, message: str | Text, actions: Sequence[tuple[str, str]], *,
                 cancel: str | None = None, error: bool = False, detail: str = "") -> None:
        super().__init__()
        self.title_text = title
        self.message = message
        self.actions = actions
        self.cancel_key = cancel
        self.error = error
        self.detail = detail

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog" + (" -error" if self.error else "")) as box:
            box.border_title = self.title_text
            yield Static(self.message, classes="message")
            if self.detail:
                with VerticalScroll(classes="detail-box"):
                    yield Static(Text(self.detail, style="#8CA7B2"), classes="message")
            yield Menu([MenuItem(key, label) for key, label in self.actions], id="choices")

    def on_mount(self) -> None:
        self.query_one("#choices", Menu).focus()

    def on_menu_selected(self, event: Menu.Selected) -> None:
        event.stop()
        self.dismiss(event.item.key)

    def action_cancel(self) -> None:
        if self.cancel_key is not None:
            self.dismiss(self.cancel_key)


def confirm(title: str, message: str, yes: str, no: str = "Cancel") -> ChoiceDialog:
    return ChoiceDialog(title, message, [("no", no), ("yes", yes)], cancel="no")


def error_dialog(title: str, exc: BaseException, actions: Sequence[tuple[str, str]]) -> ChoiceDialog:
    """The standard recoverable-error dialog: what happened, what to do, where the details are."""
    message = Text()
    message.append(str(exc) or type(exc).__name__, style="#E6F2F5")
    remedy = getattr(exc, "remedy", "")
    if remedy:
        message.append("\n\n" + remedy, style="#8CA7B2")
    message.append(f"\n\nDetails have been written to:\n{PATHS.launcher_log}", style="#58717C")
    detail = getattr(exc, "detail", "") if isinstance(exc, DSTNSLauncherError) else ""
    return ChoiceDialog(title, message, actions, cancel=actions[-1][0], error=True,
                        detail="\n".join(detail.splitlines()[-12:]) if detail else "")


class HelpDialog(ModalScreen[None]):
    BINDINGS = [Binding("escape", "close", "Close", show=False), Binding("question_mark", "close", "Close", show=False),
                Binding("enter", "close", "Close", show=False)]

    def __init__(self, lines: Sequence[tuple[str, str]]) -> None:
        super().__init__()
        self.lines = lines

    def compose(self) -> ComposeResult:
        text = Text()
        for index, (key, label) in enumerate(self.lines):
            if index:
                text.append("\n")
            text.append(key.ljust(16), style="bold #22D3E6")
            text.append(label, style="#E6F2F5")
        with Vertical(classes="dialog") as box:
            box.border_title = "Keyboard"
            yield Static(text, classes="message")
            yield Static(Text("Esc or ? closes this help.", style="#58717C"))

    def action_close(self) -> None:
        self.dismiss(None)


class TuiReporter(Reporter):
    """Delivers progress from a worker thread to the screen, at most ~10 times a second."""

    def __init__(self, app, *, on_message: Callable[[Level, str, str], None],
                 on_step: Callable[[str, str, str], None] | None = None,
                 on_output: Callable[[str], None] | None = None,
                 on_progress: Callable[[str, float, float | None], None] | None = None,
                 on_progress_done: Callable[[], None] | None = None) -> None:
        self.app = app
        self.on_message_cb = on_message
        self.on_step_cb = on_step
        self.on_output_cb = on_output
        self.on_progress_cb = on_progress
        self.on_progress_done_cb = on_progress_done
        self._last_progress = 0.0
        self._last_output = 0.0
        self._pending: list[str] = []
        self._lock = threading.Lock()

    def _call(self, callback, *args) -> None:
        if callback is None:
            return
        try:
            self.app.call_from_thread(callback, *args)
        except RuntimeError:
            # Called on the interface thread itself (or after it closed).
            try:
                callback(*args)
            except Exception:  # noqa: BLE001 - the screen may have gone away
                pass

    def message(self, level: Level, text: str, detail: str = "") -> None:
        super().message(level, text, detail)
        self._flush_output()
        self._call(self.on_message_cb, level, text, detail)

    def step_started(self, title: str) -> None:
        super().step_started(title)
        self._call(self.on_step_cb, "running", title, "")

    def step_output(self, title: str, line: str) -> None:
        super().step_output(title, line)
        with self._lock:
            self._pending.append(line)
            now = time.monotonic()
            if now - self._last_output < 0.25:
                return
            self._last_output = now
        self._flush_output()

    def _flush_output(self) -> None:
        with self._lock:
            lines, self._pending = self._pending[-200:], []
        if lines and self.on_output_cb:
            self._call(self.on_output_cb, "\n".join(lines))

    def step_finished(self, title: str, ok: bool, summary: str) -> None:
        super().step_finished(title, ok, summary)
        self._flush_output()
        self._call(self.on_step_cb, "pass" if ok else "fail", title, summary)

    def progress(self, label: str, done: float, total: float | None) -> None:
        now = time.monotonic()
        if now - self._last_progress < 0.1:
            return
        self._last_progress = now
        self._call(self.on_progress_cb, label, done, total)

    def progress_done(self) -> None:
        self._call(self.on_progress_done_cb)
