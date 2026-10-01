# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""What the terminal can do: size, colour depth, Unicode, interactivity.

Detection is conservative. When in doubt the launcher assumes less, because a
plain interface that works beats a rich one that renders as garbage.
"""
from __future__ import annotations

import locale
import os
import shutil
import sys
from dataclasses import dataclass
from enum import Enum


class Colors(Enum):
    TRUECOLOR = "truecolor"
    EXTENDED = "256"
    STANDARD = "16"
    NONE = "none"


class Layout(Enum):
    LARGE = "large"
    MEDIUM = "medium"
    SMALL = "small"
    TOO_SMALL = "too-small"


# Breakpoints, in character cells.
LARGE = (100, 30)
MEDIUM = (70, 22)
MINIMUM = (50, 15)


def layout_for(width: int, height: int) -> Layout:
    if width < MINIMUM[0] or height < MINIMUM[1]:
        return Layout.TOO_SMALL
    if width >= LARGE[0] and height >= LARGE[1]:
        return Layout.LARGE
    if width >= MEDIUM[0] and height >= MEDIUM[1]:
        return Layout.MEDIUM
    return Layout.SMALL


@dataclass(frozen=True)
class Capabilities:
    interactive: bool
    width: int
    height: int
    colors: Colors
    unicode: bool
    term: str

    @property
    def layout(self) -> Layout:
        return layout_for(self.width, self.height)

    def summary(self) -> str:
        return (f"{'interactive' if self.interactive else 'non-interactive'}, {self.width}x{self.height}, "
                f"colour {self.colors.value}, {'unicode' if self.unicode else 'ascii'}, TERM={self.term or 'unset'}")


def detect(no_color: bool = False) -> Capabilities:
    interactive = sys.stdin.isatty() and sys.stdout.isatty()
    size = shutil.get_terminal_size((80, 24))
    term = os.environ.get("TERM", "")
    return Capabilities(interactive, size.columns, size.lines, _colors(no_color, interactive, term), _unicode(), term)


def _colors(no_color: bool, interactive: bool, term: str) -> Colors:
    # https://no-color.org: any non-empty NO_COLOR disables colour.
    if no_color or os.environ.get("NO_COLOR") or term == "dumb" or not interactive:
        return Colors.NONE
    colorterm = os.environ.get("COLORTERM", "").lower()
    if colorterm in {"truecolor", "24bit"}:
        return Colors.TRUECOLOR
    if "256color" in term:
        return Colors.EXTENDED
    if os.environ.get("WT_SESSION"):  # Windows Terminal
        return Colors.TRUECOLOR
    return Colors.STANDARD


def _unicode() -> bool:
    encoding = (getattr(sys.stdout, "encoding", None) or locale.getpreferredencoding(False) or "").lower()
    return "utf" in encoding


def symbol(unicode: bool, fancy: str, plain: str) -> str:
    return fancy if unicode else plain
