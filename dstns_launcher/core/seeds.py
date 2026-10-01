# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Saved seeds: named, complete run configurations.

The store itself is ``dstns-operator-cli/seeds.py``, which other tools and the
test suite also use; this module calls it in-process rather than duplicating it.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
from contextlib import contextmanager
from functools import lru_cache
from types import ModuleType
from typing import Any, Iterator

from .errors import ConfigurationError
from .paths import PATHS, Paths


@lru_cache(maxsize=None)
def _store(root: str) -> ModuleType:
    location = os.path.join(root, "dstns-operator-cli", "seeds.py")
    spec = importlib.util.spec_from_file_location("dstns_seed_store", location)
    if spec is None or spec.loader is None:
        raise ConfigurationError("The saved-seed store is missing.", remedy=f"Restore {location}.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
            return _store(str(paths.root)).operate(action, data)
        except (ValueError, KeyError, OSError, sqlite3.Error) as exc:
            raise ConfigurationError(str(exc)) from exc
