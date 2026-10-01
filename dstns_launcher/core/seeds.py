# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Saved seeds: named, complete run configurations.

The store itself is :mod:`dstns_launcher.core.seed_store`; this module points it
at the right database and turns its errors into launcher errors.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from . import seed_store
from .errors import ConfigurationError
from .paths import PATHS, Paths


@contextmanager
def _database(paths: Paths) -> Iterator[None]:
    # The store reads DSTNS_SEED_DB itself; pass the resolved location through.
    previous = os.environ.get("DSTNS_SEED_DB")
    os.environ["DSTNS_SEED_DB"] = str(paths.seed_store)
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("DSTNS_SEED_DB", None)
        else:
            os.environ["DSTNS_SEED_DB"] = previous


def operate(action: str, data: dict[str, Any], *, paths: Paths = PATHS) -> Any:
    """``save``, ``list``, ``inspect``, ``use`` or ``delete``, exactly as the store defines them."""
    with _database(paths):
        try:
            return seed_store.operate(action, data)
        except (ValueError, KeyError, OSError, sqlite3.Error) as exc:
            raise ConfigurationError(str(exc)) from exc
