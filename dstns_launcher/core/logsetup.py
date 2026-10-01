# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The launcher's own diagnostic log, ``logs/launcher.log``."""
from __future__ import annotations

import logging
import logging.handlers
import platform
import sys

from .paths import PATHS, Paths
from .version import engine_version

LOG = logging.getLogger("dstns.launcher")


def configure(*, debug: bool = False, echo: bool = False, paths: Paths = PATHS) -> None:
    LOG.setLevel(logging.DEBUG if debug else logging.INFO)
    LOG.propagate = False
    for handler in list(LOG.handlers):
        LOG.removeHandler(handler)
    try:
        paths.logs.mkdir(parents=True, exist_ok=True)
        handler: logging.Handler = logging.handlers.RotatingFileHandler(
            paths.launcher_log, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    except OSError:
        # An unwritable logs directory is reported by the environment check;
        # it must not stop the launcher itself.
        handler = logging.NullHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    if echo:
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(logging.Formatter("[debug] %(message)s"))
        stream.set_name("console")
        LOG.addHandler(stream)
    LOG.info("launcher %s · Python %s · %s %s", engine_version(), platform.python_version(),
             platform.system(), platform.release())


def silence_console() -> None:
    """Stop echoing to the terminal, which a full-screen interface now owns."""
    for handler in list(LOG.handlers):
        if handler.get_name() == "console":
            LOG.removeHandler(handler)
