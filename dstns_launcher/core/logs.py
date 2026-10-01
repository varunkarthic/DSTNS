# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Reading the server's logs: the text system log and the SQLite journal."""
from __future__ import annotations

import sqlite3
from collections import deque
from dataclasses import dataclass

from .paths import PATHS, Paths

TABLES = {
    "api": ("api_log", "API requests"),
    "event": ("event_log", "Operator events"),
    "playback": ("lifecycle_log", "Lifecycle changes"),
}
SOURCES = {"system": "System log", **{key: label for key, (_, label) in TABLES.items()}}


@dataclass
class Table:
    columns: list[str]
    rows: list[tuple]


def system_tail(lines: int = 100, paths: Paths = PATHS) -> list[str] | None:
    """The last ``lines`` lines of ``system.log``, or ``None`` if there is none yet."""
    try:
        with paths.system_log.open(encoding="utf-8", errors="replace") as handle:
            return [line.rstrip("\n") for line in deque((line for line in handle if line.strip()), maxlen=lines)]
    except FileNotFoundError:
        return None


def journal(source: str, limit: int = 100, paths: Paths = PATHS) -> Table | None:
    """The newest rows of one journal table, oldest first; ``None`` before the first run."""
    table = TABLES[source][0]
    if not paths.runtime_db.exists():
        return None
    # Read-only, so inspecting logs can never interfere with the server writing them.
    try:
        connection = sqlite3.connect(f"file:{paths.runtime_db}?mode=ro", uri=True, timeout=2)
        connection.execute("SELECT 1 FROM sqlite_master LIMIT 1")
    except sqlite3.OperationalError:
        connection = sqlite3.connect(paths.runtime_db, timeout=2)
    try:
        cursor = connection.execute(f"SELECT * FROM {table} ORDER BY id DESC LIMIT ?", (limit,))  # noqa: S608 - fixed names
        columns = [description[0] for description in cursor.description]
        return Table(columns, list(reversed(cursor.fetchall())))
    finally:
        connection.close()


class Follower:
    """Reads lines appended to ``system.log`` since the last call."""

    def __init__(self, paths: Paths = PATHS) -> None:
        self.paths = paths
        self.offset: int | None = None

    def read(self, limit: int = 200) -> list[str]:
        try:
            size = self.paths.system_log.stat().st_size
        except FileNotFoundError:
            return []
        partial = False
        if self.offset is None or size < self.offset:
            # First read, or the file was reset: show only the recent past.
            self.offset = max(0, size - 4000) if self.offset is None else 0
            partial = self.offset > 0
        if size == self.offset:
            return []
        with self.paths.system_log.open("rb") as handle:
            handle.seek(self.offset)
            chunk = handle.read(size - self.offset)
        self.offset = size
        lines = chunk.decode(errors="replace").splitlines()
        if partial:
            lines = lines[1:]
        return [line for line in lines if line.strip()][-limit:]
