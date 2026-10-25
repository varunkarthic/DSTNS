# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The DSTNS launcher: builds, verifies, starts and supervises the simulator.

All operations live in :mod:`dstns_launcher.core`. The terminal interfaces in
:mod:`dstns_launcher.tui` (Textual) and :mod:`dstns_launcher.fallback` (Rich or
plain text) only present them, so every operation remains available when the
richer interface cannot start.
"""
import os
import sys
from pathlib import Path


def _keep_bytecode_local() -> None:
    """In a checkout a cloud client syncs, keep compiled bytecode on local disk.

    OneDrive, iCloud Drive and Dropbox evict ``__pycache__`` files they have
    uploaded; Python then waits on the network for each one, until it times
    out, before falling back to the source. (core.paths has the same test; it
    is repeated here so that nothing is imported before the prefix is set.)
    """
    root = Path(__file__).resolve().parents[1]
    synced = any(part in {"CloudStorage", "Mobile Documents", "Box"}
                 or part.startswith(("OneDrive", "Dropbox", "Google Drive", "GoogleDrive", "iCloud Drive"))
                 for part in root.parts)
    if not synced or sys.pycache_prefix:
        return
    if sys.platform == "darwin":
        cache = Path.home() / "Library" / "Caches" / "DSTNS"
    else:
        cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "dstns"
    sys.pycache_prefix = str(cache / "pycache")
    os.environ.setdefault("PYTHONPYCACHEPREFIX", sys.pycache_prefix)  # for the re-executed interpreter


_keep_bytecode_local()
