# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The project wordmark and real startup checks, with a short readable hold."""
from __future__ import annotations

import time

from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Static
from textual.worker import get_current_worker

from ...core import environment
from ...core.environment import Check, State
from ...core.version import FULL_NAME, LICENSE_SPDX, engine_version
from ..widgets import Activity, Wordmark


class SplashScreen(Screen):
    MINIMUM_SECONDS = 3.0

    def __init__(self) -> None:
        super().__init__()
        self.items: list[Check] = []
        self.started = 0.0

    def compose(self) -> ComposeResult:
        unicode = self.app.unicode
        copyright_text = "© 2026 Varun Karthic" if unicode else "(C) 2026 Varun Karthic"
        bullet = " • " if unicode else " - "
        with Vertical(id="splash"), Vertical(id="splash-content"):
            yield Wordmark()
            yield Static(FULL_NAME.upper(), classes="full-name")
            yield Static(f"v{engine_version()}", classes="version")
            yield Activity("Checking environment", classes="activity", id="activity")
            yield Static("", id="check-detail", classes="muted")
            yield Static(f"{copyright_text}{bullet}{LICENSE_SPDX}", classes="legal")

    def on_mount(self) -> None:
        self.started = time.monotonic()
        self.initialise()

    @work(thread=True, exclusive=True)
    def initialise(self) -> None:
        worker = get_current_worker()
        self.items = environment.checks()

        def update(check: Check) -> None:
            if not worker.is_cancelled:
                self.app.call_from_thread(self.check_updated, check)

        environment.run_checks(self.items, on_update=update)
        if not worker.is_cancelled:
            self.app.call_from_thread(self.finished)

    def check_updated(self, check: Check) -> None:
        if not self.is_mounted:
            return
        complete = sum(item.outcome.state not in (State.PENDING, State.RUNNING) for item in self.items)
        self.query_one("#activity", Activity).start(f"Startup checks: {complete}/{len(self.items)} complete")
        state = check.outcome.state
        word = environment.MARKERS[state][2]
        self.query_one("#check-detail", Static).update(f"{check.name}: {word}")

    def finished(self) -> None:
        if not self.is_mounted:
            return
        self.app.checks = self.items
        blocking = environment.blocking(self.items)
        label = f"{len(blocking)} required check(s) need attention" if blocking else "Startup checks complete"
        self.query_one("#activity", Activity).stop(label)
        self.query_one("#check-detail", Static).update("Opening check results" if blocking else "Opening dashboard")
        # The requested reading time overlaps real checks. Do not keep a
        # spinner running after the checks have finished or block input.
        remaining = self.MINIMUM_SECONDS - (time.monotonic() - self.started)
        if remaining > 0:
            self.set_timer(remaining, self.advance)
        else:
            self.advance()

    def advance(self) -> None:
        from .environment import EnvironmentScreen

        if environment.blocking(self.items):
            self.app.goto(EnvironmentScreen(results=self.items))
        else:
            self.app.after_environment()
