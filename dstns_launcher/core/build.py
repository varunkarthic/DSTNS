# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Building the simulation core and the observer, only when their sources changed."""
from __future__ import annotations

from dataclasses import dataclass, field
import shutil
import threading
from typing import Callable

from . import process
from .artifacts import BuildState, needs_build
from .errors import CommandFailed
from .paths import PATHS, Paths
from .reporting import Level, Reporter, duration

NATIVE_INPUTS = ["CMakeLists.txt", "src", "include", "apps/dstns_server"]
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
    #: Done in Python instead of running ``command``.
    action: Callable[[], None] | None = None
    #: The observer: if it cannot be built, the core still starts (see ensure_built).
    observer: bool = False


#: Not copied into the observer's local mirror.
MIRROR_SKIP = {"node_modules", "dist", "test-results", "playwright-report", "tsconfig.tsbuildinfo", ".DS_Store"}


def mirror_observer(paths: Paths = PATHS) -> None:
    """Copy the observer's sources, and the configuration it reads, to its local build directory.

    Only used for a synced checkout. node_modules and dist are kept between
    builds; everything else is replaced, so a deleted source cannot linger.
    """
    target = paths.observer_build
    target.mkdir(parents=True, exist_ok=True)
    for entry in target.iterdir():
        if entry.name in {"node_modules", "dist"}:
            continue
        shutil.rmtree(entry) if entry.is_dir() else entry.unlink()
    ignore = shutil.ignore_patterns(*MIRROR_SKIP)
    for entry in paths.ui_engine.iterdir():
        if entry.name in MIRROR_SKIP:
            continue
        if entry.is_dir():
            shutil.copytree(entry, target / entry.name, ignore=ignore)
        else:
            shutil.copy2(entry, target / entry.name)
    # vite.config.ts allows ../config, and the observer reads it.
    shutil.copytree(paths.root / "config", target.parent / "config", dirs_exist_ok=True)


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
    need_install = need_ui and not (paths.observer_build / "node_modules").exists()

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
    if need_ui and paths.observer_build != paths.ui_engine:
        result.steps.append(Step("Copy the observer sources to local disk", [],
                                 action=lambda: mirror_observer(paths), observer=True))
    if need_install:
        result.steps.append(Step("Install observer dependencies", ["npm", "ci", "--prefix", str(paths.observer_build)],
                                 observer=True))
    if need_ui:
        result.steps.append(Step("Build the observer", ["npm", "run", "build", "--prefix", str(paths.observer_build)],
                                 after=stamp(ui_stamp, observer), observer=True))
    return result


def execute(build_plan: BuildPlan, reporter: Reporter, paths: Paths = PATHS, *,
            cancel: threading.Event | None = None) -> None:
    """Run each step; the first failure raises :class:`~.errors.CommandFailed`."""
    for step in build_plan.steps:
        process.check_cancelled(cancel)
        reporter.step_started(step.title)
        try:
            if step.action:
                import time

                started = time.monotonic()
                step.action()
                seconds = time.monotonic() - started
            else:
                seconds = process.run(step.command, cwd=paths.root,
                                      on_line=lambda line, title=step.title: reporter.step_output(title, line),
                                      cancel=cancel).seconds
        except Exception as exc:
            reporter.step_finished(step.title, False, str(exc))
            raise
        process.check_cancelled(cancel)
        if step.after:
            step.after()
        reporter.step_finished(step.title, True, duration(seconds))


def ensure_built(reporter: Reporter, paths: Paths = PATHS, *, force_ui: bool = False,
                 cancel: threading.Event | None = None) -> bool:
    """Build whatever is out of date. Returns whether anything was built."""
    build_plan = plan(paths, force_ui=force_ui)
    if not build_plan.needed:
        return False
    core = BuildPlan([step for step in build_plan.steps if not step.observer])
    observer = BuildPlan([step for step in build_plan.steps if step.observer])
    execute(core, reporter, paths, cancel=cancel)
    if observer.needed:
        try:
            execute(observer, reporter, paths, cancel=cancel)
        except (CommandFailed, OSError) as exc:
            # The simulation does not need the observer to run; say what failed
            # and serve whatever bundle is already there, if any.
            have = (paths.ui_dist / "index.html").exists()
            reporter.message(Level.WARNING,
                             "The observer could not be built; " + ("serving the previous build" if have else
                                                                     "the simulation runs without it"),
                             observer_remedy(exc))
    return True


def observer_remedy(exc: BaseException) -> str:
    """Why an observer build failed, in one line, with what to do about it."""
    output = getattr(exc, "output", "") or str(exc)
    if "Library not loaded" in output or "dyld" in output:
        return ("Node.js is installed but does not start (a library it was built against is missing). "
                "Reinstall it - with Homebrew: brew reinstall node - then run ./launcher ui build.")
    first = (output.splitlines() or [""])[0]
    if isinstance(exc, FileNotFoundError) or "not found" in first or getattr(exc, "code", 0) == 127:
        return "Node.js 20 or later is needed to build the observer. Install it, then run ./launcher ui build."
    last = [line for line in output.splitlines() if line.strip()][-1:] or [str(exc)]
    return f"{last[0][:200]}. Fix it, then run ./launcher ui build."
