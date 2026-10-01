# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Make the terminal interface available, without ever making it a requirement.

Textual and Rich live in a private environment, ``.venv-launcher/``, created on
first interactive use. If anything here fails (no network, no ``venv`` module,
an unwritable directory), the launcher simply continues in compatibility mode.
Scripted commands never trigger an installation.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

from .core.paths import ROOT

LOG = logging.getLogger("dstns.launcher")
VENV = ROOT / ".venv-launcher"
REQUIREMENTS = Path(__file__).with_name("requirements.txt")
MARKER = "DSTNS_LAUNCHER_BOOTSTRAPPED"
NO_INSTALL = "DSTNS_LAUNCHER_NO_INSTALL"
SCRIPTED = {"seeds", "ui", "test", "sumo", "reset", "help", "version", "license"}
PLAIN_FLAGS = {"--no-tui", "--reduced-ui", "--help", "-h", "--version", "-V", "--license", "--licence"}


def wants_interface(argv: list[str]) -> bool:
    """Whether this invocation would open the full-screen interface."""
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return False
    if any(arg in PLAIN_FLAGS or arg.startswith("--mode") for arg in argv):
        return False
    values = {"--seed", "--saved-seed", "--save-seed", "--day-type", "--osm-file", "--max-nodes", "--duration",
              "--speed", "--description", "--mode"}
    skip = False
    for arg in argv:
        if skip:
            skip = False
            continue
        if arg in values:
            skip = True
            continue
        if not arg.startswith("-"):
            return arg not in SCRIPTED and not (arg == "logs" and len(argv) > argv.index(arg) + 1)
    return True


TEXTUAL_MAJOR = 8


def has_textual() -> bool:
    """Whether a compatible Textual (the pinned major version) and Rich are importable here."""
    try:
        import rich  # noqa: F401
        import textual
    except ImportError:
        return False
    try:
        return int(str(textual.__version__).split(".")[0]) >= TEXTUAL_MAJOR
    except (AttributeError, ValueError):
        return False


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ensure_interface(argv: list[str]) -> None:
    """Re-run under the private environment when that is what makes Textual available."""
    if os.environ.get(MARKER) or not wants_interface(argv) or has_textual():
        return
    python = venv_python()
    if not python.exists() or not _installed(python):
        if os.environ.get(NO_INSTALL) or not _install():
            return
    env = {**os.environ, MARKER: "1", "PYTHONPATH": os.pathsep.join(filter(None, [str(ROOT), os.environ.get("PYTHONPATH")]))}
    os.execve(str(python), [str(python), "-m", "dstns_launcher", *argv], env)


def _installed(python: Path) -> bool:
    try:
        probe = f"import rich, textual, sys; sys.exit(int(textual.__version__.split('.')[0]) < {TEXTUAL_MAJOR})"
        return subprocess.run([str(python), "-c", probe], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _install() -> bool:
    print("DSTNS: installing the terminal interface (one time, into .venv-launcher/)...", flush=True)
    try:
        if not venv_python().exists():
            subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True, capture_output=True, timeout=300)
        result = subprocess.run([str(venv_python()), "-m", "pip", "install", "--disable-pip-version-check", "-q",
                                 "-r", str(REQUIREMENTS)], capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "pip failed")
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        print(f"DSTNS: the terminal interface could not be installed ({exc}); using compatibility mode.", flush=True)
        try:
            from .core import logsetup

            logsetup.configure()
            LOG.warning("interface install failed: %s", exc)
        except Exception:  # noqa: BLE001 - logging is best effort here
            pass
        return False
    return True
