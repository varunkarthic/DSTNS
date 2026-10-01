# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Splash: the DSTNS identity, shown only while initialisation actually runs."""
from __future__ import annotations

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Static

from ...core import configuration
from ...core.errors import DSTNSLauncherError
from ...core.version import FULL_NAME, LICENSE_SPDX, engine_version
from ..widgets import Wordmark


class SplashScreen(Screen):
    def __init__(self, *, skip: bool = False) -> None:
        super().__init__()
        self.skip = skip
        self.dots = 0

    def compose(self) -> ComposeResult:
        unicode = self.app.unicode
        copyright_text = "© 2026 Varun Karthic" if unicode else "(C) 2026 Varun Karthic"
        bullet = " • " if unicode else " - "
        with Vertical(id="splash"):
            yield Wordmark()
            yield Static("DETERMINISTIC SPATIOTEMPORAL\nTRANSPORT NETWORK SIMULATOR"
                         if self.app.size.width < 60 else FULL_NAME.upper(), classes="full-name")
            yield Static(f"v{engine_version()}", classes="version")
            yield Static("Initializing", classes="activity", id="activity")
            yield Static(f"{copyright_text}{bullet}{LICENSE_SPDX}", classes="legal")

    def on_mount(self) -> None:
        # After the first refresh this screen is on the stack, so a too-small
        # notice is placed above it.
        self.call_after_refresh(lambda: self.app.apply_layout(self.app.size.width, self.app.size.height))
        self.ticker = self.set_interval(0.35, self.tick)
        self.initialise()

    def tick(self) -> None:
        self.dots = (self.dots + 1) % 4
        self.query_one("#activity", Static).update(Text("Initializing" + "." * self.dots, style="#22D3E6"))

    @work(thread=True, exclusive=True)
    def initialise(self) -> None:
        # Real work only: read the configuration so a broken file is reported
        # before anything else, and warm the version lookup.
        problem = None
        try:
            configuration.load()
        except DSTNSLauncherError as exc:
            problem = exc
        engine_version()
        self.app.call_from_thread(self.finished, problem)

    def finished(self, problem) -> None:
        from .environment import EnvironmentScreen

        self.ticker.stop()
        self.app.goto(EnvironmentScreen(config_problem=problem))
