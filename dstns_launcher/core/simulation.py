# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Starting a run on a server, following it, and controlling playback.

Everything here goes through the HTTP API, exactly as any client would. The
launcher observes and requests; it never computes anything the engine owns, so
interface timing cannot affect a run.
"""
from __future__ import annotations

import logging
import platform
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any

from . import api, configuration, seeds
from .errors import SimulationRuntimeError, SimulationStartError
from .paths import PATHS, Paths
from .reporting import Level, Reporter
from .process import check_cancelled

LOG = logging.getLogger("dstns.launcher")
POLL_SECONDS = 0.18
PREPARE_LIMIT = 30 * 60


@dataclass
class World:
    """What the server reports about the world it loaded."""

    seed: str
    day: int
    city: str = ""
    country: str = ""
    latitude: float | None = None
    longitude: float | None = None
    downloaded: bool | None = None
    nodes: int = 0
    edges: int = 0
    places: int = 0
    source: str = ""

    @property
    def place(self) -> str:
        return f"{self.city}, {self.country}" if self.city else "Pinned map"

    @property
    def day_name(self) -> str:
        return "weekend" if self.day == 1 else "weekday"


@dataclass
class Status:
    """One reading of ``/api/v1/playback/status``."""

    reachable: bool
    lifecycle: str = "UNREACHABLE"
    run_id: str = ""
    seed: str = ""
    clock: str = "00:00:00"
    virtual_seconds: float = 0
    fraction: float = 0
    tick_rate: float | None = None
    day: int = -1
    preparation_error: str = ""
    checkpoints: int | None = None

    @property
    def active(self) -> bool:
        return self.lifecycle in {"RUNNING", "PAUSED", "SEEKING", "READY"}


def prepare_request(options: configuration.RunOptions, paths: Paths = PATHS) -> dict[str, Any]:
    """The start request, saving it first if ``--save-seed`` was given."""
    request = configuration.start_request(options, paths=paths)
    if options.save_seed:
        saved = seeds.operate("save", {"id": options.save_seed, "description": options.description or "",
                                       "config": request}, paths=paths)
        request = saved["config"]
    return request


def status(port: int, paths: Paths = PATHS) -> Status:
    response = api.call(port, "/api/v1/playback/status", timeout=3, paths=paths)
    if not response.ok or not isinstance(response.body, dict):
        return Status(reachable=False)
    body = response.body
    data = body.get("data") or {}
    clock = body.get("clock") or {}
    return Status(
        reachable=True,
        lifecycle=str(data.get("lifecycle", "UNKNOWN")),
        run_id=str(body.get("run_id") or data.get("run_id") or ""),
        seed=str(body.get("seed") or ""),
        clock=str(clock.get("simulated_current_time") or "00:00:00"),
        virtual_seconds=float(clock.get("virtual_day_seconds") or 0),
        fraction=float(clock.get("simulation_percentage") or 0),
        tick_rate=clock.get("tick_rate"),
        day=int(data.get("day", -1)),
        preparation_error=str(data.get("preparation_error") or ""),
        checkpoints=data.get("checkpoint_count"),
    )


def map_status(port: int, paths: Paths = PATHS) -> dict[str, Any]:
    response = api.call(port, "/api/v1/system/map-status", timeout=2, paths=paths)
    return (response.body or {}).get("data") or {} if response.ok and isinstance(response.body, dict) else {}


def world(port: int, request_seed: str = "", day: int = 0, paths: Paths = PATHS) -> World:
    """Read the topology and check that a real OpenStreetMap network loaded."""
    response = api.call(port, "/api/v1/view/topology", timeout=60, paths=paths)
    data = (response.body or {}).get("data") if isinstance(response.body, dict) else None
    if response.code != 200 or not data or data.get("source") != "OpenStreetMap" or not data.get("nodes") or not data.get("edges"):
        raise SimulationStartError("The server did not load a usable real OSM network.",
                                   remedy="Check the map file, or start again with another seed.")
    location = data.get("location") or {}
    return World(
        seed=request_seed or str((response.body or {}).get("seed") or ""),
        day=day,
        city=str(location.get("city") or ""),
        country=str(location.get("country") or ""),
        latitude=location.get("anchor_lat"),
        longitude=location.get("anchor_lon"),
        downloaded=location.get("downloaded"),
        nodes=len(data.get("nodes") or []),
        edges=len(data.get("edges") or []),
        places=len(data.get("features") or []),
        source=str(data.get("source")),
    )


def cached_maps(paths: Paths = PATHS) -> list[str]:
    """Maps already on disk, as ``--osm-file`` arguments."""
    try:
        directory = (paths.root / (configuration.load(paths)["map"].get("cache_dir") or "data/maps")).resolve()
    except Exception:  # noqa: BLE001 - an unreadable configuration just means "look in the default place"
        directory = paths.root / "data" / "maps"
    try:
        names = sorted(name.name for name in directory.iterdir() if name.name.endswith(".osm.xml"))
    except OSError:
        return []
    out = []
    for name in names:
        full = directory / name
        try:
            out.append(str(full.relative_to(paths.root)))
        except ValueError:
            out.append(str(full))
    return out


def map_recovery(paths: Paths = PATHS) -> str:
    """What to do when a seed's city cannot be downloaded."""
    lines = [
        "The seed could not be resolved to a district, and no other city is substituted for it.",
        "Check the network, VPN or proxy, or set DSTNS_OVERPASS_ENDPOINTS to a reachable Overpass instance.",
    ]
    cached = cached_maps(paths)
    if cached:
        more = f", and {len(cached) - 4} more" if len(cached) > 4 else ""
        lines.append(f"Already downloaded: {', '.join(cached[:4])}{more}.")
        lines.append(f"Run one of them offline with: ./launcher start --osm-file {cached[0]}")
    return "\n".join(lines)


def start_run(port: int, request: dict[str, Any], reporter: Reporter, paths: Paths = PATHS,
              cancel: threading.Event | None = None) -> World:
    """Start a run and wait until the world is live, reporting real progress."""
    check_cancelled(cancel)
    on_demand = request["map"]["osm_file"] == "auto"
    reporter.message(Level.INFO,
                     "Resolving the seed to a city district" if on_demand else "Loading the OpenStreetMap district",
                     "downloading from OpenStreetMap if not already cached" if on_demand else request["map"]["osm_file"])
    response = api.call(port, "/api/v1/playback/start", "POST", request, paths=paths)
    if response.code != 202:
        message = response.error_message() if response.code else "The server could not be reached."
        if response.error_code() == "MAP_FETCH_FAILED":
            raise SimulationStartError(message, remedy=map_recovery(paths))
        if response.error_code() == "CLI_START_REQUIRED":
            raise SimulationStartError(message, remedy="The operator credential in logs/operator.token does not match this server.")
        raise SimulationStartError(f"Startup failed: {message}")

    deadline = time.monotonic() + PREPARE_LIMIT
    drew = False
    current = Status(reachable=False)
    try:
        while time.monotonic() < deadline:
            if cancel is not None and cancel.is_set():
                api.call(port, "/api/v1/playback/reset", "POST", {}, timeout=5, paths=paths)
                raise SimulationStartError("Start-up was cancelled.")
            current = status(port, paths)
            if current.lifecycle in {"RUNNING", "PAUSED", "READY"}:
                break
            if current.lifecycle == "IDLE" and current.preparation_error:
                raise SimulationStartError(current.preparation_error,
                                           remedy=map_recovery(paths) if on_demand else "Check the map file.")
            if on_demand:
                progress = map_status(port, paths)
                if progress.get("active"):
                    drew = True
                    where = progress.get("city") or "map"
                    if progress.get("phase") == "download":
                        total = progress.get("total") or 0
                        reporter.progress(f"Downloading {where}", float(progress.get("bytes") or 0), float(total) if total else None)
                    else:
                        phase = "Validating" if progress.get("phase") == "parse" else "Contacting OpenStreetMap for"
                        reporter.progress(f"{phase} {where}", 0, None)
            time.sleep(POLL_SECONDS)
        else:
            raise SimulationStartError("The world was not ready within 30 minutes.")
    finally:
        if drew:
            reporter.progress_done()

    # The day type may be the seed's own ("auto"); the engine has resolved it.
    requested = request.get("day", "auto")
    day = requested if requested in (0, 1) else (current.day if current.day in (0, 1) else 0)
    loaded = world(port, str(request.get("seed", "")), day, paths)
    if loaded.city:
        reporter.message(Level.INFO, "District",
                         f"{loaded.place} · {loaded.latitude:.4f}, {loaded.longitude:.4f}"
                         f"{' (downloaded)' if loaded.downloaded else ' (cached)'}")
    reporter.message(Level.SUCCESS, f"Simulation running · {loaded.seed} · {loaded.day_name}",
                     f"{loaded.nodes:,} road nodes · {loaded.places:,} buildings and places")
    return loaded


def control(port: int, action: str, paths: Paths = PATHS) -> api.Response:
    """``play``, ``pause`` or ``restart`` (back to 00:00:00 in the same world)."""
    routes = {
        "play": ("/api/v1/playback/play", {}),
        "pause": ("/api/v1/playback/pause", {}),
        "restart": ("/api/v1/playback/seek", {"target_time": 0, "play": True}),
    }
    route, payload = routes[action]
    response = api.call(port, route, "POST", payload, timeout=60, paths=paths)
    if not response.ok:
        raise SimulationRuntimeError(f"Could not {action} the simulation: {response.error_message()}")
    return response


def wait_for_observer(port: int, timeout: float, paths: Paths = PATHS, *,
                      cancel: threading.Event | None = None) -> bool:
    """Wait until the observer page has loaded, so start-up is watched there."""
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        check_cancelled(cancel)
        response = api.call(port, "/api/v1/system/observer", timeout=2, paths=paths)
        if isinstance(response.body, dict) and (response.body.get("data") or {}).get("loaded"):
            return True
        time.sleep(0.15)
    return False


def open_in_browser(url: str) -> bool:
    """Open ``url`` with the platform's handler, without a shell."""
    system = platform.system()
    if system == "Darwin":
        command = ["open", url]
    elif system == "Windows":
        command = ["cmd", "/c", "start", "", url]
    else:
        command = ["xdg-open", url]
    try:
        return subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=15).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def can_open_browser() -> bool:
    """The launcher's default for ``--open``: a desktop is present."""
    import os

    return platform.system() in {"Darwin", "Windows"} or bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


@dataclass
class Metrics:
    """Network totals the engine reports; ``None`` where it reported nothing."""

    vehicles: int | None = None
    halting: int | None = None
    mean_speed_kmh: float | None = None
    congestion: float | None = None
    congestion_average: float | None = None
    flooded_roads: int | None = None
    closed_roads: int | None = None
    storms: int | None = None
    target_rate: float | None = None


def metrics(port: int, paths: Paths = PATHS) -> Metrics:
    result = Metrics()
    traffic = api.call(port, "/api/v1/view/traffic", timeout=3, paths=paths)
    if traffic.ok and isinstance(traffic.body, dict):
        data = traffic.body.get("data") or {}
        result.vehicles = data.get("vehicle_count")
        result.halting = data.get("halting_vehicle_count")
        speed = data.get("mean_vehicle_speed_mps")
        result.mean_speed_kmh = None if speed is None else float(speed) * 3.6
        result.flooded_roads = data.get("flooded_edge_count")
        result.closed_roads = data.get("closed_edge_count")
        result.storms = data.get("active_dws_events")
        result.target_rate = (traffic.body.get("clock") or {}).get("target_virtual_rate")
    congestion = api.call(port, "/api/v1/view/congestion", timeout=3, paths=paths)
    if congestion.ok and isinstance(congestion.body, dict):
        data = congestion.body.get("data") or {}
        result.congestion = data.get("current")
        result.congestion_average = data.get("average")
    return result


def remaining_wall_seconds(current: Status, rate: float | None) -> float | None:
    """Wall-clock time to the end of the day at the current rate, while running."""
    if current.lifecycle != "RUNNING" or not rate or rate <= 0:
        return None
    return max(0.0, (86400 - current.virtual_seconds) / rate)


def server_usage(pid: int) -> tuple[float, float] | None:
    """(CPU per cent, resident MiB) of a process, measured with ``ps``; ``None`` if unavailable."""
    try:
        out = subprocess.run(["ps", "-o", "%cpu=,rss=", "-p", str(pid)], capture_output=True, text=True,
                             timeout=3, stdin=subprocess.DEVNULL).stdout.split()
        return float(out[0]), float(out[1]) / 1024
    except (OSError, subprocess.TimeoutExpired, ValueError, IndexError):
        return None
