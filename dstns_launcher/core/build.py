# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Building the simulation core and the observer, only when their sources changed."""
from __future__ import annotations

from dataclasses import dataclass, field
import threading
from typing import Callable

from . import process
from .artifacts import BuildState, needs_build
from .paths import PATHS, Paths
from .reporting import Reporter, duration

NATIVE_INPUTS = ["CMakeLists.txt", "cmake", "src", "include", "shaders", "apps/dstns_server"]
UI_INPUTS = [
    "ui-engine/src", "ui-engine/public", "ui-engine/package.json", "ui-engine/package-lock.json",
    "ui-engine/index.html", "ui-engine/vite.config.ts", "ui-engine/tsconfig.json",
]


@dataclass
class Step:
    title: str
    command: list[str]
    after: Callable[[], None] | None = None
    cwd_is_root: bool = True


@dataclass
class BuildPlan:
    steps: list[Step] = field(default_factory=list)

    @property
    def needed(self) -> bool:
        return bool(self.steps)


def plan(paths: Paths = PATHS, *, force_native: bool = False, force_ui: bool = False) -> BuildPlan:
    native_stamp = paths.build / ".launcher-source"
    ui_stamp = paths.ui_dist / ".launcher-source"
    native: BuildState | None = None
    observer: BuildState | None = None
    if (paths.root / "src").exists():
        native = needs_build(paths.root, NATIVE_INPUTS, paths.server, native_stamp)
    if (paths.ui_engine / "src").exists():
        observer = needs_build(paths.root, UI_INPUTS, paths.ui_dist / "index.html", ui_stamp)
    need_native = force_native or not paths.server.exists() or bool(native and native.needed)
    need_ui = force_ui or not (paths.ui_dist / "index.html").exists() or bool(observer and observer.needed)
    need_install = need_ui and not (paths.ui_engine / "node_modules").exists()

    def stamp(path, state: BuildState | None) -> Callable[[], None]:
        def write() -> None:
            if state:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(state.fingerprint, encoding="utf-8")
        return write

    result = BuildPlan()
    if need_native:
        result.steps.append(Step("Configure the build", [
            "cmake", "-S", str(paths.root), "-B", str(paths.build), "-DDSTNS_BUILD_TESTS=ON", "-DCMAKE_BUILD_TYPE=Release"]))
        result.steps.append(Step("Compile the simulation core", [
            "cmake", "--build", str(paths.build), "-j4"],
            after=stamp(native_stamp, native)))
    if need_install:
        result.steps.append(Step("Install observer dependencies", ["npm", "ci", "--prefix", str(paths.ui_engine)]))
    if need_ui:
        result.steps.append(Step("Build the observer", ["npm", "run", "build", "--prefix", str(paths.ui_engine)],
                                 after=stamp(ui_stamp, observer)))
    return result


def execute(build_plan: BuildPlan, reporter: Reporter, paths: Paths = PATHS, *,
            cancel: threading.Event | None = None) -> None:
    """Run each step; the first failure raises :class:`~.errors.CommandFailed`."""
    for step in build_plan.steps:
        process.check_cancelled(cancel)
        reporter.step_started(step.title)
        try:
            result = process.run(step.command, cwd=paths.root,
                                 on_line=lambda line, title=step.title: reporter.step_output(title, line), cancel=cancel)
        except Exception as exc:
            reporter.step_finished(step.title, False, str(exc))
            raise
        process.check_cancelled(cancel)
        if step.after:
            step.after()
        reporter.step_finished(step.title, True, duration(result.seconds))


def ensure_built(reporter: Reporter, paths: Paths = PATHS, *, force_ui: bool = False,
                 cancel: threading.Event | None = None) -> bool:
    """Build whatever is out of date. Returns whether anything was built."""
    build_plan = plan(paths, force_ui=force_ui)
    if not build_plan.needed:
        return False
    execute(build_plan, reporter, paths, cancel=cancel)
    return True
