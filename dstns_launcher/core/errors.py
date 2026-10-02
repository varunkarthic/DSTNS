# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Launcher errors.

Each carries an optional ``remedy``: what the operator can do about it. The
interfaces show the message and the remedy, never a bare code. Underlying
Python and system exceptions are chained (``raise … from``) rather than
replaced, so the launcher log keeps the original cause.
"""
from __future__ import annotations


class DSTNSLauncherError(Exception):
    """Base class. ``str(error)`` is a complete sentence for the operator."""

    def __init__(self, message: str, *, remedy: str = "", detail: str = "") -> None:
        super().__init__(message)
        self.remedy = remedy
        self.detail = detail


class EnvironmentCheckError(DSTNSLauncherError):
    """This machine cannot run DSTNS as it stands."""


class ConfigurationError(DSTNSLauncherError):
    """A configuration file or a run option is invalid."""


class DependencyError(DSTNSLauncherError):
    """A required program or package is missing."""


class SimulationStartError(DSTNSLauncherError):
    """The server or the run could not be started."""


class SimulationRuntimeError(DSTNSLauncherError):
    """A running server or run failed."""


class UIInitializationError(DSTNSLauncherError):
    """A terminal interface could not start."""


class OperationCancelled(DSTNSLauncherError):
    """The operator cancelled an operation before it completed."""

    def __init__(self) -> None:
        super().__init__("Start-up was cancelled.")


class CommandFailed(DSTNSLauncherError):
    """An external command exited with a non-zero status."""

    def __init__(self, command: list[str], code: int, output: str) -> None:
        super().__init__(f"{' '.join(command[:3])} exited with status {code}.", detail=output)
        self.command = command
        self.code = code
        self.output = output
