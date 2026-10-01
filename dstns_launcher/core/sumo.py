# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Eclipse SUMO: detection and the standalone toolchain check."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import process
from .errors import DependencyError
from .paths import PATHS, Paths
from .reporting import Level, Reporter, duration

PREFIXES = [Path.home() / "sumo" / "bin", Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/usr/bin")]


@dataclass
class Sumo:
    sumo: Path
    netconvert: Path
    works: bool
    version: str


def detect() -> Sumo | None:
    """Find ``sumo`` and ``netconvert`` the way the server does, and check they start."""
    directories = []
    if os.environ.get("SUMO_HOME"):
        directories.append(Path(os.environ["SUMO_HOME"]) / "bin")
    directories += PREFIXES
    pair = None
    for directory in directories:
        if (directory / "sumo").exists() and (directory / "netconvert").exists():
            pair = (directory / "sumo", directory / "netconvert")
            break
    if pair is None:
        found = shutil.which("sumo"), shutil.which("netconvert")
        if not all(found):
            return None
        pair = (Path(found[0]), Path(found[1]))
    version, works = "", True
    for binary in pair:
        try:
            result = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=15,
                                    stdin=subprocess.DEVNULL, errors="replace")
            works = works and result.returncode == 0
            if binary.name == "sumo":
                match = re.search(r"Version\s+(\S+)", result.stdout)
                version = match.group(1) if match else ""
        except (OSError, subprocess.TimeoutExpired):
            works = False
    return Sumo(pair[0], pair[1], works, version)


def run_standalone(reporter: Reporter, paths: Paths = PATHS) -> dict[str, str]:
    """Export a synthetic grid, convert it and run SUMO on it: a toolchain check."""
    found = detect()
    if not found:
        raise DependencyError("SUMO binaries (sumo, netconvert) were not found on PATH or under $SUMO_HOME",
                              remedy="Install Eclipse SUMO, or set SUMO_HOME to its installation.")
    if not paths.export_tool.exists():
        from .build import ensure_built

        ensure_built(reporter, paths)
    directory = paths.root / "data" / "sumo_live_run"
    directory.mkdir(parents=True, exist_ok=True)
    tripinfo = directory / "tripinfo.xml"
    tripinfo.unlink(missing_ok=True)
    steps = [
        ("Export a deterministic scenario", [str(paths.export_tool), "--export-sumo", str(directory), "--grid", "12x12"]),
        ("Compile the SUMO network", [str(found.netconvert), f"--node-files={directory / 'network.nod.xml'}",
                                      f"--edge-files={directory / 'network.edg.xml'}",
                                      f"--output-file={directory / 'network.net.xml'}", "--no-warnings=true"]),
        ("Run the microscopic simulation", [str(found.sumo), "-c", str(directory / "sandbox.sumocfg"), "--begin", "0",
                                            "--end", "3600", "--seed", "42", f"--tripinfo-output={tripinfo}",
                                            "--no-step-log=true", "--duration-log.disable=true"]),
    ]
    for title, command in steps:
        reporter.step_started(title)
        try:
            result = process.run(command, cwd=directory, on_line=lambda line, t=title: reporter.step_output(t, line))
        except Exception as exc:
            reporter.step_finished(title, False, str(exc))
            raise
        reporter.step_finished(title, True, duration(result.seconds))
    summary = {"Output directory": str(directory.relative_to(paths.root))}
    if tripinfo.exists():
        trips = [line for line in tripinfo.read_text(encoding="utf-8", errors="replace").splitlines() if "<tripinfo" in line]
        summary["Trip file"] = str(tripinfo.relative_to(paths.root))
        summary["Trips completed"] = f"{len(trips):,}"
        reporter.message(Level.SUCCESS, "SUMO toolchain works", f"{len(trips):,} trips")
    return summary
