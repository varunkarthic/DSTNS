# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""How long operations tell an interface what they are doing.

Operations call these methods; each interface supplies its own subclass. The
base class only logs, so an operation can run with no interface at all.
"""
from __future__ import annotations

import logging
from enum import Enum

LOG = logging.getLogger("dstns.launcher")


class Level(Enum):
    INFO = "info"
    SUCCESS = "success"
    WARNING = "warning"
    ERROR = "error"


class Reporter:
    def message(self, level: Level, text: str, detail: str = "") -> None:
        LOG.log(logging.WARNING if level in (Level.WARNING, Level.ERROR) else logging.INFO,
                "%s%s", text, f" ({detail})" if detail else "")

    def step_started(self, title: str) -> None:
        LOG.info("step: %s", title)

    def step_output(self, title: str, line: str) -> None:
        LOG.debug("%s | %s", title, line)

    def step_finished(self, title: str, ok: bool, summary: str) -> None:
        LOG.log(logging.INFO if ok else logging.ERROR, "step %s: %s", "done" if ok else "failed", f"{title}: {summary}")

    def progress(self, label: str, done: float, total: float | None) -> None:
        """A determinate (``total`` known) or indeterminate activity."""

    def progress_done(self) -> None:
        """The activity reported through :meth:`progress` has ended."""


def duration(seconds: float) -> str:
    if seconds < 1:
        return f"{seconds * 1000:.0f} ms"
    if seconds < 60:
        return f"{seconds:.1f} s"
    return f"{int(seconds // 60)} min {int(seconds % 60)} s"
