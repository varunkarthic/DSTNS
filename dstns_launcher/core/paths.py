# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Where the launcher finds and writes things.

Every path is derived from the repository root, so the launcher works from any
working directory. ``DSTNS_LOGS_DIR`` moves the logs directory, as it always has.

A checkout inside OneDrive, iCloud Drive, Dropbox or Google Drive is common, and
those clients evict files to the cloud: reading or appending to one then waits on
the network and can time out, and some refuse the burst of file creation a build
makes. When the checkout is synced, everything DSTNS generates is therefore kept
on local disk, and only the sources stay in the synced folder:

==============================  =====================================================
the launcher's log              ``~/Library/Logs/DSTNS/launcher.log``
the server's logs and database  ``~/Library/Logs/DSTNS/logs-<id>/``
the C++ build                   ``~/Library/Caches/DSTNS/checkout-<id>/build/``
the observer's build            ``~/Library/Caches/DSTNS/checkout-<id>/source/ui-engine/``
downloaded city extracts        ``~/Library/Caches/DSTNS/checkout-<id>/maps/``
the launcher's environment      ``~/Library/Caches/DSTNS/venv-launcher-<id>/``
==============================  =====================================================

(the XDG state and cache directories elsewhere; ``<id>`` names the checkout).
``DSTNS_LOGS_DIR`` and ``DSTNS_BUILD_DIR`` choose the first two outright.
"""
from __future__ import annotations

import hashlib
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


def checkout_id(root: Path) -> str:
    """A short, stable name for one checkout, so two checkouts never share a build."""
    return hashlib.sha256(str(Path(root).resolve()).encode()).hexdigest()[:10]


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
    def synced(self) -> bool:
        """Whether this checkout is in a cloud-synced folder (see the module notes)."""
        return cloud_synced(self.root)

    @property
    def local_workspace(self) -> Path:
        """Where a synced checkout's builds live."""
        return local_cache_dir() / f"checkout-{checkout_id(self.root)}"

    @property
    def logs(self) -> Path:
        override = os.environ.get("DSTNS_LOGS_DIR")
        if override:
            return Path(override).resolve()
        if self.synced:
            return local_state_dir() / f"logs-{checkout_id(self.root)}"
        return self.root / "logs"

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
        override = os.environ.get("DSTNS_BUILD_DIR")
        if override:
            return Path(override).expanduser().resolve()
        return self.local_workspace / "build" if self.synced else self.root / "build"

    @property
    def server(self) -> Path:
        return self.build / "dstns_server"

    @property
    def export_tool(self) -> Path:
        return self.build / "dstns_scenario_export"

    @property
    def ui_engine(self) -> Path:
        """The observer's sources."""
        return self.root / "ui-engine"

    @property
    def observer_build(self) -> Path:
        """Where npm installs and builds the observer: the sources themselves, or a
        local mirror of them in a synced checkout (node_modules alone is tens of
        thousands of files a sync client would upload and then evict)."""
        return self.local_workspace / "source" / "ui-engine" if self.synced else self.ui_engine

    @property
    def ui_dist(self) -> Path:
        return self.observer_build / "dist"

    def map_cache(self, configured: str | None = None) -> Path:
        """Where city extracts are cached: ``map.cache_dir``, except that the default,
        data/maps, moves to local disk in a synced checkout. Extracts are tens of
        megabytes and re-downloadable; an evicted one would time out on loading."""
        configured = configured or "data/maps"
        if self.synced and Path(configured) == Path("data/maps"):
            return self.local_workspace / "maps"
        return (self.root / configured).resolve()

    def server_environment(self) -> dict[str, str]:
        """What the server needs besides its arguments: where the observer is, when not in the checkout."""
        if self.ui_dist != self.ui_engine / "dist":
            return {"DSTNS_UI_DIST": str(self.ui_dist)}
        return {}

    @property
    def seed_store(self) -> Path:
        override = os.environ.get("DSTNS_SEED_DB")
        return Path(override) if override else self.root / "data" / "seed-store" / "seeds.sqlite3"


PATHS = Paths(ROOT)
