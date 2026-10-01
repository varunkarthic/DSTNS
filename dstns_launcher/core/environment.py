# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Environment checks: can this machine run DSTNS right now?

Every check is a real test of this installation, and reports what it found, not
just pass or fail. A failure means a run cannot work; a warning means something
is reduced or will be fixed automatically on start. Checks are ordered
cheapest first; the test-suite checks are optional because they take seconds.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable

from .paths import PATHS, Paths
from .sumo import detect as detect_sumo


class State(Enum):
    PENDING = "pending"
    RUNNING = "running"
    PASS = "pass"
    WARNING = "warning"
    FAIL = "fail"
    SKIPPED = "skipped"


#: (unicode symbol, ascii symbol, word) for each state; never colour alone.
MARKERS: dict[State, tuple[str, str, str]] = {
    State.PENDING: ("○", "o", "Pending"),
    State.RUNNING: ("◌", "~", "Checking"),
    State.PASS: ("✓", "+", "OK"),
    State.WARNING: ("!", "!", "Warning"),
    State.FAIL: ("✗", "x", "Failed"),
    State.SKIPPED: ("-", "-", "Skipped"),
}


@dataclass
class Outcome:
    state: State
    value: str
    detail: str = ""
    remedy: str = ""


@dataclass
class Check:
    key: str
    name: str
    run: Callable[[], Outcome]
    required: bool = True
    slow: bool = False
    outcome: Outcome = field(default_factory=lambda: Outcome(State.PENDING, ""))
    seconds: float = 0.0


def _command(command: list[str], *, cwd=None, timeout: float = 60, env: dict[str, str] | None = None) -> tuple[int, str, float]:
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, errors="replace",
                                timeout=timeout, stdin=subprocess.DEVNULL, env={**os.environ, **(env or {})})
        return result.returncode, (result.stdout + result.stderr), time.monotonic() - started
    except FileNotFoundError:
        return 127, f"{command[0]} not found", time.monotonic() - started
    except subprocess.TimeoutExpired:
        return -1, "timed out", time.monotonic() - started


def checks(paths: Paths = PATHS, *, suites: bool = False) -> list[Check]:
    root = paths.root

    def host() -> Outcome:
        supported = sys.platform in {"darwin", "linux"}
        try:
            memory = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
            memory_text = f" · {memory:.1f} GB"
        except (ValueError, OSError, AttributeError):
            memory_text = ""
        value = f"{platform.system()} {platform.release()} · {platform.machine()} · {os.cpu_count()} cores{memory_text}"
        return Outcome(State.PASS if supported else State.WARNING, value,
                       remedy="" if supported else "Only macOS and Linux are supported; use WSL 2 or Docker on Windows.")

    def python() -> Outcome:
        ok = sys.version_info >= (3, 10)
        return Outcome(State.PASS if ok else State.WARNING, platform.python_version(),
                       remedy="" if ok else "Python 3.10 or later is supported; older versions are not tested.")

    def node() -> Outcome:
        code, out, _ = _command(["node", "--version"], timeout=10)
        if code != 0:
            return Outcome(State.WARNING, "not found", "Needed only to build the observer.",
                           remedy="Install Node.js 20 or later if the observer must be rebuilt.")
        match = re.search(r"v(\d+)", out)
        major = int(match.group(1)) if match else 0
        ok = major >= 20
        return Outcome(State.PASS if ok else State.WARNING, out.strip(),
                       remedy="" if ok else "Node.js 20 or later is needed to build the observer.")

    def toolchain() -> Outcome:
        missing = [tool for tool in ("cmake", "c++") if shutil.which(tool) is None]
        if paths.server.exists():
            return Outcome(State.PASS if not missing else State.WARNING,
                           "cmake and a C++ compiler" if not missing else f"{', '.join(missing)} missing",
                           remedy="" if not missing else "Needed only to rebuild the core after a change.")
        return Outcome(State.FAIL if missing else State.PASS,
                       "cmake and a C++ compiler" if not missing else f"{', '.join(missing)} missing",
                       remedy="Install CMake 3.22+ and a C++20 compiler; see the installation guide." if missing else "")

    def licence() -> Outcome:
        try:
            text = (root / "LICENSE").read_text(encoding="utf-8")
        except OSError:
            return Outcome(State.WARNING, "LICENSE is missing",
                           remedy="DSTNS is distributed under AGPL-3.0-or-later; the licence text should ship with it.")
        agpl = "GNU AFFERO GENERAL PUBLIC LICENSE" in text
        return Outcome(State.PASS if agpl else State.WARNING, "AGPL-3.0-or-later" if agpl else "not the AGPL text")

    def run_configuration() -> Outcome:
        from . import configuration
        from .errors import ConfigurationError

        problems = []
        try:
            configuration.load(paths)
        except ConfigurationError as exc:
            problems.append(str(exc))
        try:
            json.loads(paths.ui_config.read_text(encoding="utf-8"))
        except FileNotFoundError:
            problems.append("config/ui-config.json is missing")
        except ValueError as exc:
            problems.append(f"config/ui-config.json: {exc}")
        if problems:
            return Outcome(State.FAIL, "invalid", "; ".join(problems),
                           remedy="Correct the file, or restore it with git checkout -- config/")
        return Outcome(State.PASS, "defaults.json and ui-config.json valid")

    def interface_configuration() -> Outcome:
        try:
            config = json.loads(paths.ui_config.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return Outcome(State.WARNING, "unreadable; built-in defaults apply")
        problems: list[str] = []

        def one_of(value, allowed, name):
            if value is not None and value not in allowed:
                problems.append(f'{name} "{value}"')

        categories = ["weather", "flooding", "incident", "traffic", "demand", "signals", "system"]
        layers = ["roads", "signals", "labels", "place_names", "other_places", "traffic", "vehicles",
                  "buildings", "weather", "flooding", "incidents", "events"]
        one_of(config.get("reduce_motion"), ["auto", "on", "off"], "reduce_motion")
        one_of((config.get("auto_focus") or {}).get("mode"), ["disable", "enable", "enable-force"], "auto_focus.mode")
        one_of((config.get("auto_focus") or {}).get("strategy"), ["round-robin", "latest"], "auto_focus.strategy")
        one_of((config.get("playback") or {}).get("skip_seconds"), [60, 300, 900, 3600], "playback.skip_seconds")
        one_of((config.get("playback") or {}).get("step_seconds"), [1, 10, 60, 300], "playback.step_seconds")
        for value in (config.get("notifications") or {}).get("dnd_categories") or []:
            one_of(value, categories, "notifications.dnd_categories")
        for value in (config.get("notifications") or {}).get("dnd_severities") or []:
            one_of(value, ["info", "warning", "alert"], "notifications.dnd_severities")
        for key, value in (config.get("layers") or {}).items():
            if not isinstance(value, bool):
                problems.append(f"layers.{key} is not true or false")
            if key not in layers:
                problems.append(f"layers.{key} is not a layer")
        if problems:
            return Outcome(State.WARNING, f"{len(problems)} value(s) ignored", "ignored: " + ", ".join(problems),
                           remedy="Correct these values in config/ui-config.json; the defaults apply meanwhile.")
        return Outcome(State.PASS, "all values recognised")

    def map_fetcher() -> Outcome:
        script = root / "scripts" / "fetch_osm.py"
        if not script.exists():
            return Outcome(State.FAIL, "scripts/fetch_osm.py missing", remedy="Seeds cannot resolve to a city without it.")
        code, out, _ = _command([sys.executable, "-m", "py_compile", str(script)], timeout=15)
        return Outcome(State.PASS if code == 0 else State.FAIL, "compiles" if code == 0 else "does not compile",
                       out.strip()[:200], remedy="" if code == 0 else "Restore scripts/fetch_osm.py from the repository.")

    def map_cache() -> Outcome:
        directory = root / "data" / "maps"
        probe = directory / f".preflight-{os.getpid()}"
        try:
            directory.mkdir(parents=True, exist_ok=True)
            probe.write_text("x")
            probe.unlink()
        except OSError as exc:
            return Outcome(State.FAIL, "not writable", str(exc), remedy=f"Make {directory} writable by this user.")
        extracts = [entry for entry in directory.iterdir() if entry.name.endswith(".osm.xml")]
        size = sum(entry.stat().st_size for entry in extracts) / 1024**2
        if not extracts:
            return Outcome(State.PASS, "empty; extracts download on demand")
        return Outcome(State.PASS, f"{len(extracts)} cached extract{'s' if len(extracts) != 1 else ''} · {size:.0f} MiB")

    def workspace() -> Outcome:
        probe = paths.logs / f".preflight-{os.getpid()}"
        try:
            paths.logs.mkdir(parents=True, exist_ok=True)
            probe.write_text("x")
            probe.unlink()
        except OSError as exc:
            return Outcome(State.FAIL, "not writable", str(exc), remedy=f"Make {paths.logs} writable by this user.")
        return Outcome(State.PASS, "logs directory writable")

    def core() -> Outcome:
        if not paths.server.exists():
            return Outcome(State.WARNING, "not built", remedy="It is compiled automatically before the first run.")
        code, out, _ = _command([str(paths.server), "--version"], timeout=10)
        return Outcome(State.PASS if code == 0 else State.WARNING,
                       out.splitlines()[0].strip() if code == 0 and out else "present, no version reported")

    def observer() -> Outcome:
        index = paths.ui_dist / "index.html"
        if not index.exists():
            return Outcome(State.WARNING, "not built", remedy="It is built automatically before the first run.")
        from .build import UI_INPUTS
        from .artifacts import needs_build

        stale = needs_build(root, UI_INPUTS, index, paths.ui_dist / ".launcher-source").needed
        return Outcome(State.WARNING if stale else State.PASS, "older than its sources" if stale else "current",
                       remedy="It is rebuilt automatically before the next run." if stale else "")

    def sumo() -> Outcome:
        found = detect_sumo()
        if not found:
            return Outcome(State.SKIPPED, "not installed", "Optional: only the SUMO adapter needs it.")
        return Outcome(State.PASS if found.works else State.WARNING, found.version or "found",
                       "" if found.works else "sumo or netconvert does not start",
                       remedy="" if found.works else "Reinstall SUMO, or set SUMO_HOME; see Troubleshooting.")

    def port() -> Outcome:
        from . import configuration

        try:
            wanted = int(os.environ.get("DSTNS_API_PORT") or configuration.load(paths)["api"]["port"])
        except Exception:  # noqa: BLE001 - reported by the configuration check
            wanted = 8090
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", wanted))
                return Outcome(State.PASS, f"{wanted} available")
            except OSError:
                return Outcome(State.PASS, f"{wanted} in use",
                               "A running DSTNS server is reused; otherwise the next free port is chosen.")

    def ctest() -> Outcome:
        if not (paths.build / "CTestTestfile.cmake").exists():
            return Outcome(State.SKIPPED, "not configured", remedy="Run cmake -S . -B build -DDSTNS_BUILD_TESTS=ON to enable.")
        code, out, seconds = _command(["ctest", "--test-dir", str(paths.build), "--output-on-failure"], cwd=root, timeout=300)
        clean = re.search(r"(\d+)% tests passed out of (\d+)", out)
        dirty = re.search(r"(\d+)% tests passed,\s*(\d+) tests failed out of (\d+)", out)
        if code == 0 and not dirty:
            total = clean.group(2) if clean else "all"
            return Outcome(State.PASS, f"{total}/{total} suites passed in {seconds:.1f}s")
        failed = dirty.group(2) if dirty else "some"
        return Outcome(State.FAIL, f"{failed} suite(s) failed", out[-1500:],
                       remedy="The core is not behaving as specified; run ctest --test-dir build --output-on-failure.")

    def api_suite() -> Outcome:
        script = root / "tests" / "api" / "api_smoke.py"
        if not paths.server.exists() or not script.exists():
            return Outcome(State.SKIPPED, "core not built")
        code, out, seconds = _command([sys.executable, str(script), "--server", str(paths.server)], cwd=root, timeout=180)
        match = re.search(r"PASSED:\s*(\d+) assertions", out)
        if code == 0:
            return Outcome(State.PASS, f"{match.group(1) if match else 'all'} assertions passed in {seconds:.1f}s")
        return Outcome(State.FAIL, "HTTP contract violated", out[-1500:], remedy="Run python3 tests/api/api_smoke.py for details.")

    def loading_suite() -> Outcome:
        if not paths.server.exists():
            return Outcome(State.SKIPPED, "core not built")
        code, out, seconds = _command([sys.executable, str(root / "tests" / "api" / "loading_smoke.py")], cwd=root, timeout=60)
        if code == 0:
            return Outcome(State.PASS, f"start-up, polling, regeneration and cancellation passed in {seconds:.1f}s")
        return Outcome(State.FAIL, "loading regression", out[-1500:], remedy="Run python3 tests/api/loading_smoke.py for details.")

    def observer_suite() -> Outcome:
        if not (paths.ui_engine / "node_modules").exists():
            return Outcome(State.SKIPPED, "dependencies not installed")
        code, out, seconds = _command(["npx", "vitest", "run"], cwd=paths.ui_engine, timeout=300, env={"CI": "1"})
        passed = re.search(r"Tests\s+(\d+)\s+passed", out)
        if code == 0:
            count = passed.group(1) if passed else "all"
            return Outcome(State.PASS, f"{count}/{count} tests passed in {seconds:.1f}s")
        failed = re.search(r"(\d+)\s+failed", out)
        return Outcome(State.FAIL, f"{failed.group(1) if failed else 'some'} test(s) failed", out[-1500:],
                       remedy="Run npm test --prefix ui-engine for details.")

    result = [
        Check("host", "Host platform", host),
        Check("python", "Python", python),
        Check("toolchain", "Build tools", toolchain),
        Check("node", "Node.js", node, required=False),
        Check("licence", "Licence", licence, required=False),
        Check("configuration", "Configuration", run_configuration),
        Check("interface", "Observer settings", interface_configuration, required=False),
        Check("workspace", "Workspace", workspace),
        Check("fetcher", "Map downloader", map_fetcher),
        Check("cache", "Map cache", map_cache),
        Check("core", "Simulation core", core),
        Check("observer", "Observer bundle", observer, required=False),
        Check("port", "API port", port, required=False),
        Check("sumo", "SUMO", sumo, required=False),
    ]
    if suites:
        result += [
            Check("ctest", "Core test suites", ctest, slow=True),
            Check("api", "API contract suite", api_suite, slow=True),
            Check("loading", "Loading suite", loading_suite, slow=True),
            Check("vitest", "Observer test suites", observer_suite, required=False, slow=True),
        ]
    return result


def run_checks(items: list[Check], on_update: Callable[[Check], None] | None = None, *, parallel: int = 4) -> list[Check]:
    """Run every check, reporting each state change. Fast checks run concurrently;
    the test suites run one at a time because they compete for the machine."""

    def execute(check: Check) -> None:
        check.outcome = Outcome(State.RUNNING, "")
        if on_update:
            on_update(check)
        started = time.monotonic()
        try:
            check.outcome = check.run()
        except Exception as exc:  # noqa: BLE001 - a broken check must be reported, not crash the launcher
            check.outcome = Outcome(State.FAIL, "check failed", f"{type(exc).__name__}: {exc}")
        check.seconds = time.monotonic() - started
        if on_update:
            on_update(check)

    quick = [check for check in items if not check.slow]
    with ThreadPoolExecutor(max_workers=parallel) as pool:
        list(pool.map(execute, quick))
    for check in items:
        if check.slow:
            execute(check)
    return items


def blocking(items: list[Check]) -> list[Check]:
    """Required checks that failed: the reasons a run cannot start."""
    return [check for check in items if check.required and check.outcome.state is State.FAIL]
