# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Running external programs.

Commands are always argument lists, never shell strings, so a path or a value
can never be interpreted by a shell.
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from .errors import CommandFailed, DependencyError, OperationCancelled

LOG = logging.getLogger("dstns.launcher")
LineCallback = Callable[[str], None]


def check_cancelled(cancel: threading.Event | None) -> None:
    if cancel is not None and cancel.is_set():
        raise OperationCancelled()


def terminate(child: subprocess.Popen) -> None:
    """Stop the command and its build-tool descendants, including pipe holders."""
    def send(sig: int) -> None:
        try:
            if os.name == "posix":
                os.killpg(child.pid, sig)
            elif child.poll() is None:
                child.send_signal(sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS may return EPERM for an orphaned group after SIGTERM has
            # left only reparented zombies. A live command must still surface
            # a genuine permission failure.
            if child.poll() is None:
                raise
            LOG.debug("process group %s no longer signalable after exit", child.pid)

    send(signal.SIGTERM)
    try:
        child.wait(timeout=1.5)
    except subprocess.TimeoutExpired:
        pass
    # A descendant can outlive its parent while holding stdout open.
    if os.name == "posix":
        send(signal.SIGKILL)
    elif child.poll() is None:
        child.kill()
    child.wait(timeout=5)


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
    check_cancelled(cancel)
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
            start_new_session=os.name == "posix",
        )
    except FileNotFoundError as exc:
        raise DependencyError(f"{command[0]} was not found.", remedy=f"Install {Path(str(command[0])).name} and make sure it is on PATH.") from exc
    tail: deque[str] = deque(maxlen=keep)
    timed_out = False
    finished = threading.Event()

    def watchdog() -> None:
        nonlocal timed_out
        deadline = None if timeout is None else started + timeout
        # A build tool can exit while its descendants still hold stdout open.
        # Keep watching until the output reader has finished as well.
        while not finished.wait(0.1):
            if (deadline is not None and time.monotonic() > deadline) or (cancel is not None and cancel.is_set()):
                timed_out = deadline is not None and time.monotonic() > deadline
                terminate(child)
                return

    guard = threading.Thread(target=watchdog, daemon=True)
    guard.start()
    assert child.stdout is not None
    try:
        for line in child.stdout:
            line = line.rstrip("\n")
            tail.append(line)
            if on_line and line.strip():
                on_line(line)
        code = child.wait()
    except BaseException:
        terminate(child)
        raise
    finally:
        finished.set()
        child.stdout.close()
        guard.join(timeout=2)
    check_cancelled(cancel)
    result = Result(124 if timed_out else code, "\n".join(tail), time.monotonic() - started, timed_out)
    if check and result.code != 0:
        raise CommandFailed([str(part) for part in command], result.code, result.output)
    return result


def tail_text(text: str, lines: int = 14) -> str:
    return "\n".join([line for line in text.splitlines() if line.strip()][-lines:])
