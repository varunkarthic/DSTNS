# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The launcher's own diagnostic log, ``logs/launcher.log``.

The log is best effort. If it cannot be written - a full disk, a directory that
vanished, a sync client that has evicted the file - logging stops quietly for
the rest of the session instead of printing a traceback for every line.
"""
from __future__ import annotations

import logging
import logging.handlers
import platform
import sys

from .paths import PATHS, Paths, dataless
from .version import engine_version

LOG = logging.getLogger("dstns.launcher")


class QuietFileHandler(logging.handlers.RotatingFileHandler):
    """A rotating log that goes silent after its first failure."""

    failed = False

    def emit(self, record: logging.LogRecord) -> None:
        if not self.failed:
            super().emit(record)

    def handleError(self, record: logging.LogRecord) -> None:  # noqa: N802 - logging's name
        self.failed = True
        try:
            if self.stream:
                self.stream.close()
        except OSError:
            pass
        self.stream = None  # type: ignore[assignment]


def configure(*, debug: bool = False, echo: bool = False, paths: Paths = PATHS) -> None:
    LOG.setLevel(logging.DEBUG if debug else logging.INFO)
    LOG.propagate = False
    for handler in list(LOG.handlers):
        LOG.removeHandler(handler)
    log = paths.launcher_log
    try:
        if dataless(log):
            # Appending would first download the old log, and may time out.
            raise OSError("launcher.log is a cloud placeholder")
        log.parent.mkdir(parents=True, exist_ok=True)
        # delay: open on the first record, so a failure there is handled
        # quietly by QuietFileHandler rather than raised from here.
        handler: logging.Handler = QuietFileHandler(log, maxBytes=1_000_000, backupCount=2, encoding="utf-8", delay=True)
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
