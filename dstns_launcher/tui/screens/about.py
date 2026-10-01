# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""About: version, copyright, licence and map-data attribution."""
from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Static

from ...core.version import (DOCUMENTATION, FULL_NAME, LICENSE_NAME, LICENSE_SPDX, OSM_LICENSE, REPOSITORY,
                             engine_version, observer_version)
from ..base import Page
from ..widgets import Key, Row, Rule, StatusTable, Wordmark


class AboutScreen(Page):
    TITLE_TEXT = "About"
    KEYS = [Key("Esc", "Back", "Back", essential=True)]

    def compose_body(self) -> ComposeResult:
        unicode = self.app.unicode
        with VerticalScroll(classes="body"):
            yield Static("")
            yield Wordmark()
            yield Static(Text(FULL_NAME, style="bold #E6F2F5"))
            yield Rule()
            yield StatusTable([
                Row("Version", engine_version()),
                Row("Observer", observer_version()),
                Row("Copyright", "Copyright © 2026 Varun Karthic" if unicode else "Copyright (C) 2026 Varun Karthic"),
                Row("Licence", LICENSE_NAME),
                Row("SPDX", LICENSE_SPDX),
            ], name_width=12)
            yield Static("Map data", classes="section-title")
            yield Static(Text.assemble(
                ("© OpenStreetMap contributors" if unicode else "(C) OpenStreetMap contributors", "#E6F2F5"),
                ("\nOpenStreetMap data is available under the\n" + OSM_LICENSE + ".", "#8CA7B2")))
            yield Static("Project", classes="section-title")
            yield StatusTable([Row("Source", REPOSITORY), Row("Documentation", DOCUMENTATION)], name_width=14)
            yield Static(Text("\nThis program comes with ABSOLUTELY NO WARRANTY. It is free software, and you are welcome\n"
                              "to redistribute it under the terms of the licence; see LICENSE.", style="#58717C"))
