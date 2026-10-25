# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Where the launcher finds and writes things.

Every path is derived from the repository root, so the launcher works from any
working directory. ``DSTNS_LOGS_DIR`` moves the logs directory, as it always has.

A checkout inside OneDrive, iCloud Drive, Dropbox or Google Drive is common, and
those clients evict files to the cloud: reading or appending to one then waits on
the network and can time out. The launcher's own files - its log and its private
Python environment - are therefore kept on local disk when the checkout is
synced (``~/Library/Logs/DSTNS``, ``~/Library/Caches/DSTNS`` on macOS; the XDG
state and cache directories elsewhere).
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

#: SF_DATALESS (macOS): the file is a cloud placeholder; its contents are not on this machine.
DATALESS = 0x40000000
_SYNC_PREFIXES = ("OneDrive", "Dropbox", "Google Drive", "GoogleDrive", "iCloud Drive")
_SYNC_NAMES = {"Box", "Mobile Documents", "CloudStorage"}


def cloud_synced(path: Path) -> bool:
    """Whether ``path`` lies in a folder a cloud client syncs (and may evict)."""
    return any(part in _SYNC_NAMES or part.startswith(_SYNC_PREFIXES) for part in Path(path).resolve().parts)


def dataless(path: Path) -> bool:
    """Whether ``path`` is a cloud placeholder, so that reading it would wait on the network."""
    try:
        return bool(getattr(os.stat(path), "st_flags", 0) & DATALESS)
    except OSError:
        return False


def local_state_dir() -> Path:
    """Logs that must stay on this machine."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Logs" / "DSTNS"
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "dstns"


def local_cache_dir() -> Path:
    """Rebuildable files that must stay on this machine."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "DSTNS"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "dstns"


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def config(self) -> Path:
        return self.root / "config" / "defaults.json"

    @property
    def ui_config(self) -> Path:
        return self.root / "config" / "ui-config.json"

    @property
    def logs(self) -> Path:
        override = os.environ.get("DSTNS_LOGS_DIR")
        return Path(override).resolve() if override else self.root / "logs"

    @property
    def active_server(self) -> Path:
        return self.logs / "launcher.json"

    @property
    def launcher_log(self) -> Path:
        # Kept off a synced folder: a log that may be evicted to the cloud turns
        # every line written into a network wait, and then a timeout.
        if cloud_synced(self.logs):
            return local_state_dir() / "launcher.log"
        return self.logs / "launcher.log"

    @property
    def token(self) -> Path:
        return self.logs / "operator.token"

    @property
    def runtime_db(self) -> Path:
        return self.logs / "runtime.db"

    @property
    def system_log(self) -> Path:
        return self.logs / "system.log"

    @property
    def build(self) -> Path:
        return self.root / "build"

    @property
    def server(self) -> Path:
        return self.build / "dstns_server"

    @property
    def export_tool(self) -> Path:
        return self.build / "dstns_scenario_export"

    @property
    def ui_engine(self) -> Path:
        return self.root / "ui-engine"

    @property
    def ui_dist(self) -> Path:
        return self.ui_engine / "dist"

    @property
    def seed_store(self) -> Path:
        override = os.environ.get("DSTNS_SEED_DB")
        return Path(override) if override else self.root / "data" / "seed-store" / "seeds.sqlite3"


PATHS = Paths(ROOT)
