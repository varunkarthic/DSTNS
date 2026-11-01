# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""One launcher session: the server it uses and the run it started.

Both interfaces drive a session the same way, so starting, observing and
stopping behave identically whichever one is on screen.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

from . import api, narration, server, simulation
from . import configuration
from .configuration import RunOptions
from .errors import ConfigurationError, SimulationStartError
from .process import check_cancelled
from .paths import PATHS, Paths
from .reporting import Level, Reporter
from .server import ServerHandle
from .simulation import World

LOG = logging.getLogger("dstns.launcher")

# How long the observer has the screen before the engine is asked for a world.
OBSERVER_LEAD_S = 3.5


@dataclass
class Session:
    paths: Paths = PATHS
    handle: ServerHandle | None = None
    world: World | None = None
    observed_existing: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)
    _closed: bool = field(default=False, repr=False)
    launching: bool = field(default=False, init=False)
    _launch_done: threading.Event = field(default_factory=threading.Event, repr=False)

    def __post_init__(self) -> None:
        self._launch_done.set()

    def launch(self, options: RunOptions, reporter: Reporter, *, open_browser: bool = False,
               cancel: threading.Event | None = None) -> World | None:
        """Start (or reuse) a server and start a run, or observe the run already there.

        Returns the world, or ``None`` when an existing run is being observed.
        """
        with self._lock:
            if self._closed:
                from .errors import OperationCancelled

                raise OperationCancelled()
            self._cancel = cancel if cancel is not None else threading.Event()
            self.launching = True
            self._launch_done.clear()
        try:
            return self._launch(options, reporter, open_browser=open_browser, cancel=self._cancel)
        finally:
            self.launching = False
            self._launch_done.set()

    def _launch(self, options: RunOptions, reporter: Reporter, *, open_browser: bool,
                cancel: threading.Event) -> World | None:
        check_cancelled(cancel)
        request = simulation.prepare_request(options, self.paths)
        handle = server.start(reporter, self.paths, cancel=cancel)
        with self._lock:
            # Re-attaching to the server this session started must not forget
            # that the session owns it (and must stop it on exit).
            ours = self.handle is not None and self.handle.managed and self.handle.port == handle.port
            if not (ours and not handle.managed):
                self.handle = handle
        if cancel.is_set():
            if handle.process is not None:
                server.stop_process(handle.process)
            check_cancelled(cancel)
        health = handle.health or {}
        observing = health.get("lifecycle") in {"RUNNING", "PAUSED"} and not options.explicit()
        address = self._observer_address(handle.url, options)
        if open_browser and not observing:
            simulation.open_in_browser(address)
            loaded = simulation.wait_for_observer(handle.port, 12, self.paths, cancel=cancel)
            reporter.message(Level.INFO, "Observer open" if loaded else "Observer opening",
                             f"{handle.url} · preparing the world")
            # Intentional: the observer opens on its title and starts its film before
            # any world is requested, so the whole start-up is seen from the beginning.
            if loaded and cancel.wait(OBSERVER_LEAD_S):
                check_cancelled(cancel)
        check_cancelled(cancel)
        if observing:
            current = api.call(handle.port, "/api/v1/view/topology", timeout=60, paths=self.paths)
            if ((current.body or {}).get("data") or {}).get("source") != "OpenStreetMap":
                raise SimulationStartError(
                    "The active server is running a synthetic fixture. Stop that run before launching an OSM simulation.")
            reporter.message(Level.INFO, "Observing the existing real OSM simulation")
            self.observed_existing = True
            self.world = None
        else:
            self.world = simulation.start_run(handle.port, request, reporter, self.paths, cancel=cancel)
            self.observed_existing = False
            if handle.managed:
                narration.confirm(handle.port, reporter, self.paths, cancel=cancel)
        reporter.message(Level.INFO, "Observer ready", handle.url)
        if open_browser and observing:
            simulation.open_in_browser(address)
        return self.world

    def _observer_address(self, url: str, options: RunOptions) -> str:
        """The page to open: asked to forget this browser's settings, if so configured."""
        wanted = options.default_settings
        if not wanted:
            try:
                wanted = bool((configuration.load(self.paths).get("launcher") or {}).get("default_settings"))
            except ConfigurationError:
                wanted = False
        return f"{url}?defaults" if wanted else url

    @property
    def port(self) -> int | None:
        return self.handle.port if self.handle else None

    def stop_server(self) -> bool:
        """Terminate the server gracefully. Returns whether it has stopped."""
        if not self.handle:
            return True
        stopped = server.shut_down(self.handle)
        LOG.info("server on port %s stopped: %s", self.handle.port, stopped)
        return stopped

    def cleanup(self) -> None:
        """Stop a server this session started; leave one it attached to running."""
        with self._lock:
            self._closed = True
            self._cancel.set()
            handle = self.handle
        if handle and handle.process is not None and handle.process.poll() is None:
            LOG.info("cleanup: stopping managed server on port %s", handle.port)
            server.stop_process(handle.process)
        # Keep the cancellation watchdog alive until a build or pending start
        # has observed cancellation. Do not let a daemon worker spawn a server
        # after the launcher has exited.
        self._launch_done.wait(timeout=5)
