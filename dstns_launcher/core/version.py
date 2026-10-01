# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Version and licence metadata, read from the project rather than repeated.

The engine version is defined once, in ``project(dstns VERSION …)`` in
``CMakeLists.txt``; the observer's in ``ui-engine/package.json``.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from .paths import ROOT

PRODUCT = "DSTNS"
FULL_NAME = "Deterministic Spatiotemporal Transport Network Simulator"
COPYRIGHT = "© 2026 Varun Karthic"
COPYRIGHT_ASCII = "(C) 2026 Varun Karthic"
LICENSE_SPDX = "AGPL-3.0-or-later"
LICENSE_NAME = "GNU Affero General Public License v3.0 or later"
OSM_ATTRIBUTION = "© OpenStreetMap contributors"
OSM_LICENSE = "Open Data Commons Open Database License (ODbL)"
REPOSITORY = "https://github.com/varunkarthic/DSTNS"
DOCUMENTATION = "https://dstns.readthedocs.io/"

_PROJECT = re.compile(r"project\(\s*dstns\s+VERSION\s+([0-9]+(?:\.[0-9]+){1,3})", re.IGNORECASE)


@lru_cache(maxsize=None)
def engine_version(root: Path = ROOT) -> str:
    """The DSTNS version, or ``"unknown"`` if CMakeLists.txt cannot be read."""
    try:
        match = _PROJECT.search((root / "CMakeLists.txt").read_text(encoding="utf-8"))
    except OSError:
        return "unknown"
    return match.group(1) if match else "unknown"


@lru_cache(maxsize=None)
def observer_version(root: Path = ROOT) -> str:
    try:
        return str(json.loads((root / "ui-engine" / "package.json").read_text(encoding="utf-8"))["version"])
    except (OSError, ValueError, KeyError):
        return "unknown"
