# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Clearing runtime data. Maps, saved seeds and configuration are never touched."""
from __future__ import annotations

import shutil

from .paths import PATHS, Paths
from .reporting import Level, Reporter

RUNTIME_FILES = ("system.log", "runtime.db", "runtime.db-wal", "runtime.db-shm")
RUNTIME_DIRECTORIES = ("checkpoints", "scenarios", "sumo_live_run")


def describe(paths: Paths = PATHS) -> list[str]:
    """What a reset deletes, for the confirmation."""
    return [str(paths.logs / name) for name in RUNTIME_FILES] + [str(paths.root / "data" / name) for name in RUNTIME_DIRECTORIES]


def reset(reporter: Reporter, paths: Paths = PATHS) -> None:
    reporter.step_started("Clear runtime logs")
    for name in RUNTIME_FILES:
        (paths.logs / name).unlink(missing_ok=True)
    reporter.step_finished("Clear runtime logs", True, "logs cleared")
    for name, title in zip(RUNTIME_DIRECTORIES, ("Reset checkpoints", "Reset temporary scenarios", "Reset SUMO runs")):
        reporter.step_started(title)
        directory = paths.root / "data" / name
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True, exist_ok=True)
        reporter.step_finished(title, True, "done")
    reporter.message(Level.SUCCESS, "Runtime state reset", "map cache, saved seeds and configuration kept")
