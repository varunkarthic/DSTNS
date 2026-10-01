# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Running external programs.

Commands are always argument lists, never shell strings, so a path or a value
can never be interpreted by a shell.
"""
from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from .errors import CommandFailed, DependencyError

LOG = logging.getLogger("dstns.launcher")
LineCallback = Callable[[str], None]


@dataclass
class Result:
    code: int
    output: str
    seconds: float
    timed_out: bool = False


def run(
    command: Sequence[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    on_line: LineCallback | None = None,
    timeout: float | None = None,
    check: bool = True,
    keep: int = 400,
    cancel: threading.Event | None = None,
) -> Result:
    """Run ``command``, streaming each output line to ``on_line``.

    The last ``keep`` lines are returned. With ``check``, a non-zero exit
    raises :class:`CommandFailed` carrying that output.
    """
    LOG.debug("run: %s (cwd=%s)", " ".join(str(part) for part in command), cwd)
    started = time.monotonic()
    try:
        child = subprocess.Popen(
            [str(part) for part in command],
            cwd=cwd,
            env={**os.environ, **(env or {})},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
        )
    except FileNotFoundError as exc:
        raise DependencyError(f"{command[0]} was not found.", remedy=f"Install {Path(str(command[0])).name} and make sure it is on PATH.") from exc
    tail: deque[str] = deque(maxlen=keep)
    timed_out = False

    def watchdog() -> None:
        nonlocal timed_out
        deadline = None if timeout is None else started + timeout
        while child.poll() is None:
            if (deadline is not None and time.monotonic() > deadline) or (cancel is not None and cancel.is_set()):
                timed_out = deadline is not None and time.monotonic() > deadline
                child.kill()
                return
            time.sleep(0.1)

    guard = threading.Thread(target=watchdog, daemon=True)
    guard.start()
    assert child.stdout is not None
    for line in child.stdout:
        line = line.rstrip("\n")
        tail.append(line)
        if on_line and line.strip():
            on_line(line)
    code = child.wait()
    guard.join(timeout=1)
    result = Result(code, "\n".join(tail), time.monotonic() - started, timed_out)
    if check and code != 0:
        raise CommandFailed([str(part) for part in command], code, result.output)
    return result


def tail_text(text: str, lines: int = 14) -> str:
    return "\n".join([line for line in text.splitlines() if line.strip()][-lines:])
