# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""What the launcher is made of: modules, each adding commands and pages to it.

A module says what it adds, and the command line, its help and the dashboard are built from that,
so adding to the launcher means adding a module rather than changing them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class Context:
    """What a command is given to work with."""

    arguments: list[str]
    caps: Any
    out: Any
    reporter: Any
    session: Any


@dataclass(frozen=True)
class Command:
    name: str
    usage: str
    summary: str
    run: Callable[[Context], int]


@dataclass(frozen=True)
class Page:
    """An entry on the dashboard, and the screen it opens."""

    key: str
    label: str
    opens: Callable[[], Any]
    # (title, rows, hint text) for the dashboard's detail panel, given the running app.
    describe: Callable[[Any], tuple[str, list, str]] | None = None
    # Where it goes in the menu: before the entry with this key.
    before: str = "seeds"


@dataclass(frozen=True)
class Module:
    name: str
    commands: tuple[Command, ...] = ()
    pages: tuple[Page, ...] = ()


def modules() -> list[Module]:
    """Imported here, so that a command that needs none of them starts quickly."""
    from . import apps, fabric, fastboot, presentation

    return [apps.MODULE, fabric.MODULE, fastboot.MODULE, presentation.MODULE]


def find_command(name: str | None) -> Command | None:
    for module in modules():
        for command in module.commands:
            if command.name == name:
                return command
    return None


def pages() -> list[Page]:
    return [page for module in modules() for page in module.pages]


def help_lines() -> list[str]:
    lines = []
    for module in modules():
        for command in module.commands:
            lines.append(f"  {command.usage}")
            lines.append(f"                         {command.summary}")
    return lines
