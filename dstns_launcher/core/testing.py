# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The test stages ``./launcher test [scope]`` runs."""
from __future__ import annotations

import sys
from dataclasses import dataclass

from . import process
from .paths import PATHS, Paths
from .reporting import Reporter, duration


@dataclass(frozen=True)
class Stage:
    title: str
    command: tuple[str, ...]


@dataclass
class StageResult:
    title: str
    passed: bool
    seconds: float
    detail: str = ""


SCOPES = ("all", "unit", "api", "replay", "benchmark", "sumo", "ui")


def stages(scope: str, paths: Paths = PATHS) -> list[Stage]:
    build, server, root, ui = str(paths.build), str(paths.server), paths.root, str(paths.ui_engine)
    python = sys.executable
    configure = Stage("Configure the test build", ("cmake", "-S", str(root), "-B", build, "-DDSTNS_BUILD_TESTS=ON"))
    compile_ = Stage("Build the core and test binaries", ("cmake", "--build", build, "-j4"))
    unit = Stage("Native suites (unit, property, replay, performance, HTTP)", ("ctest", "--test-dir", build, "--output-on-failure"))
    replay = Stage("Reproducibility verification", (str(paths.build / "dstns_replay_verify"),))
    benchmark = Stage("Routing and snapshot benchmark", (str(paths.build / "dstns_benchmark"),))
    api = Stage("HTTP contract suite", (python, str(root / "tests" / "api" / "api_smoke.py"), "--server", server))
    sumo = Stage("SUMO integration smoke test", ("bash", str(root / "tests" / "integration" / "sumo_smoke.sh")))
    observer = Stage("Observer test suites", ("npm", "test", "--prefix", ui))
    bundle = Stage("Production observer bundle", ("npm", "run", "build", "--prefix", ui))
    return {
        "all": [configure, compile_, unit, replay, benchmark, api, sumo, observer, bundle],
        "unit": [unit],
        "api": [api],
        "replay": [replay],
        "benchmark": [benchmark],
        "sumo": [sumo],
        "ui": [observer],
    }.get(scope, [configure, compile_, unit, replay, benchmark, api, sumo, observer, bundle])


def run(scope: str, reporter: Reporter, paths: Paths = PATHS) -> list[StageResult]:
    """Run every stage of ``scope``; a failing stage does not stop the others."""
    results = []
    for stage in stages(scope, paths):
        reporter.step_started(stage.title)
        try:
            result = process.run(list(stage.command), cwd=paths.root, check=False,
                                 on_line=lambda line, t=stage.title: reporter.step_output(t, line))
            passed, detail = result.code == 0, "" if result.code == 0 else process.tail_text(result.output, 10)
            seconds = result.seconds
        except Exception as exc:  # noqa: BLE001 - a missing tool fails the stage, not the run
            passed, detail, seconds = False, str(exc), 0.0
        results.append(StageResult(stage.title, passed, seconds, detail))
        reporter.step_finished(stage.title, passed, duration(seconds) if passed else (detail.splitlines() or ["failed"])[-1][:140])
    return results
