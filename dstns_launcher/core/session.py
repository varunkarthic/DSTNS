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

from . import api, server, simulation
from .configuration import RunOptions
from .errors import SimulationStartError
from .paths import PATHS, Paths
from .reporting import Level, Reporter
from .server import ServerHandle
from .simulation import World

LOG = logging.getLogger("dstns.launcher")


@dataclass
class Session:
    paths: Paths = PATHS
    handle: ServerHandle | None = None
    world: World | None = None
    observed_existing: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def launch(self, options: RunOptions, reporter: Reporter, *, open_browser: bool = False,
               cancel: threading.Event | None = None) -> World | None:
        """Start (or reuse) a server and start a run, or observe the run already there.

        Returns the world, or ``None`` when an existing run is being observed.
        """
        request = simulation.prepare_request(options, self.paths)
        handle = server.start(reporter, self.paths)
        with self._lock:
            # Re-attaching to the server this session started must not forget
            # that the session owns it (and must stop it on exit).
            ours = self.handle is not None and self.handle.managed and self.handle.port == handle.port
            if not (ours and not handle.managed):
                self.handle = handle
        health = handle.health or {}
        observing = health.get("lifecycle") in {"RUNNING", "PAUSED"} and not options.explicit()
        if open_browser and not observing:
            simulation.open_in_browser(handle.url)
            loaded = simulation.wait_for_observer(handle.port, 12, self.paths)
            reporter.message(Level.INFO, "Observer open" if loaded else "Observer opening",
                             f"{handle.url} · preparing the world")
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
        reporter.message(Level.INFO, "Observer ready", handle.url)
        if open_browser and observing:
            simulation.open_in_browser(handle.url)
        return self.world

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
        handle = self.handle
        if handle and handle.process is not None and handle.process.poll() is None:
            LOG.info("cleanup: stopping managed server on port %s", handle.port)
            server.stop_process(handle.process)
