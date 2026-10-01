# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The Textual launcher application."""
from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from rich.text import Text
from textual import events
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Static

from ..core import logsetup
from ..core.session import Session
from ..core.terminal import MINIMUM, Capabilities, Layout, layout_for
from .base import confirm

LOG = logging.getLogger("dstns.launcher")


@dataclass
class Outcome:
    """How the interface ended, for the command line to act on."""

    code: int = 0
    reduced: bool = False
    error: BaseException | None = None
    resume: str | None = None


class TooSmallScreen(Screen):
    """Shown instead of a cramped layout; the screen underneath keeps its state."""

    BINDINGS = [Binding("r", "reduced", "Reduced mode"), Binding("ctrl+c", "app.request_quit", "Quit", priority=True)]

    def compose(self) -> ComposeResult:
        yield Static("", id="too-small")

    def on_mount(self) -> None:
        self.refresh_text()

    def on_resize(self, _event: events.Resize) -> None:
        self.refresh_text()

    def refresh_text(self) -> None:
        width, height = self.app.size
        text = Text(justify="center")
        text.append("DSTNS\n\n", style="bold #22D3E6")
        text.append("Terminal too small for the full interface.\n\n", style="#E6F2F5")
        text.append(f"Current: {width} x {height}\n", style="#8CA7B2")
        text.append(f"Recommended minimum: {MINIMUM[0]} x {MINIMUM[1]}\n\n", style="#8CA7B2")
        text.append("Resize the terminal or press R for reduced mode.", style="#E6F2F5")
        self.query_one("#too-small", Static).update(text)

    def action_reduced(self) -> None:
        self.app.leave_for_reduced()


class LauncherApp(App[Outcome]):
    CSS_PATH = Path(__file__).with_name("theme.tcss")
    TITLE = "DSTNS"
    ENABLE_COMMAND_PALETTE = False

    BINDINGS = [
        Binding("ctrl+c", "request_quit", "Quit", priority=True, show=False),
        Binding("ctrl+q", "request_quit", "Quit", priority=True, show=False),
    ]

    def __init__(self, args, caps: Capabilities, session: Session, initial: str) -> None:
        super().__init__()
        self.args = args
        self.caps = caps
        self.session = session
        self.initial = initial
        self.unicode = caps.unicode
        self.layout_class = Layout.LARGE
        self.too_small: TooSmallScreen | None = None
        self._pending: list = []
        self._layout_ready = False
        self.launcher_error: BaseException | None = None
        self.checks = None  # the last environment check results
        self.run_log: deque[str] = deque(maxlen=2000)  # survives leaving the running screen
        self.resume = initial

    # -- start-up -------------------------------------------------------------
    def on_mount(self) -> None:
        from .screens.splash import SplashScreen

        # The splash applies the size classes once it is on screen, so a
        # too-small notice is always shown above it.
        self.push_screen(SplashScreen(skip=self.args.no_splash))

    def after_environment(self) -> None:
        """Called once the environment check passes: show the dashboard, then the requested screen."""
        from .screens.dashboard import DashboardScreen

        self.goto(DashboardScreen())
        if self.initial == "start":
            from .screens.running import RunningScreen

            self.open(RunningScreen(options=self.args.run))
        elif self.initial == "config":
            from .screens.configuration import ConfigurationScreen

            self.open(ConfigurationScreen())
        elif self.initial == "logs":
            from .screens.logs import LogsScreen

            self.open(LogsScreen())
        self.initial = "home"

    # -- responsive layout --------------------------------------------------------
    def on_resize(self, event: events.Resize) -> None:
        # Textual reports a size before the first screen exists; the splash
        # applies the layout once it is on screen.
        if self._layout_ready:
            self.apply_layout(event.size.width, event.size.height)

    def apply_layout(self, width: int, height: int) -> None:
        self._layout_ready = True
        layout = layout_for(width, height)
        self.layout_class = layout
        if layout is Layout.TOO_SMALL:
            if self.too_small is None:
                self.too_small = TooSmallScreen()
                self.push_screen(self.too_small)
            return
        if self.too_small is not None:
            self.too_small = None
            self.pop_screen()
        for name in ("large", "medium", "small"):
            self.set_class(layout.value == name, f"-{name}")
        # Screens that were hidden while the class changed restyle now.
        self.call_after_refresh(self.refresh_css, False)
        self.call_after_refresh(self._run_pending)

    # -- navigation, deferred while the terminal is too small ------------------------
    def _run_pending(self) -> None:
        pending, self._pending = list(getattr(self, "_pending", [])), []
        for action in pending:
            action()

    def _defer(self, action) -> bool:
        if self.too_small is not None:
            if not hasattr(self, "_pending"):
                self._pending = []
            self._pending.append(action)
            return True
        return False

    def goto(self, screen: Screen) -> None:
        """Replace the current page."""
        if not self._defer(lambda: self.switch_screen(screen)):
            self.switch_screen(screen)

    def open(self, screen: Screen, callback=None) -> None:
        """Open a page or dialog on top of the current one."""
        if not self._defer(lambda: self.push_screen(screen, callback)):
            self.push_screen(screen, callback)

    # -- leaving ---------------------------------------------------------------------
    def action_request_quit(self) -> None:
        handle = self.session.handle
        if handle is not None and handle.managed and handle.running():
            def decided(choice: str | None) -> None:
                if choice == "yes":
                    self.stop_and_exit()

            self.push_screen(confirm("Simulation running",
                                     "The simulation is still running. Stop it and exit?",
                                     "Stop simulation and exit", "Cancel"), decided)
            return
        self.exit(Outcome(0))

    def stop_and_exit(self) -> None:
        from .screens.running import stop_in_background

        stop_in_background(self, then=lambda: self.exit(Outcome(0)))

    def leave_for_reduced(self) -> None:
        self.exit(Outcome(0, reduced=True, resume="home"))

    # -- failures ----------------------------------------------------------------------
    def _handle_exception(self, error: Exception) -> None:
        # Record it for the command line, which logs it and switches to compatibility mode.
        if self.launcher_error is None:
            self.launcher_error = error
        super()._handle_exception(error)

    def _print_error_renderables(self) -> None:
        # Tracebacks are for --debug; otherwise the command line explains what happened.
        if getattr(self.args, "debug", False):
            super()._print_error_renderables()
        else:
            self._exit_renderables.clear()


def run_tui(args, caps: Capabilities, session: Session, initial: str) -> Outcome:
    """Run the interface. Raises if it cannot start; reports a crash in the outcome."""
    from ..bootstrap import has_textual

    if not has_textual():
        raise ImportError("A compatible version of Textual is not installed.")
    if not caps.interactive:
        from ..core.errors import UIInitializationError

        raise UIInitializationError("No interactive terminal is available.")
    logsetup.silence_console()
    app = LauncherApp(args, caps, session, initial)
    result = app.run(mouse=True)
    if app.launcher_error is not None:
        return Outcome(1, error=app.launcher_error, resume=app.resume)
    return result if isinstance(result, Outcome) else Outcome(app.return_code or 0)
