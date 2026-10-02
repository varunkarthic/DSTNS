# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Compatibility mode: every launcher operation through numbered menus.

It needs nothing beyond ``print`` and ``input``; Rich, when present, only makes
it easier to read. It never redraws the screen or moves the cursor, so it works
over any connection and in any terminal.
"""
from __future__ import annotations

import logging
from typing import Callable

from ..core import configuration, environment, logs, maintenance, server, simulation, sumo, testing
from ..core import seeds as seed_store
from ..core.configuration import RunOptions
from ..core.environment import State
from ..core.errors import DSTNSLauncherError
from ..core.paths import PATHS
from ..core.reporting import Level
from ..core.session import Session
from ..core.terminal import Capabilities
from ..core.version import (DOCUMENTATION, FULL_NAME, LICENSE_NAME, LICENSE_SPDX, OSM_ATTRIBUTION, OSM_LICENSE,
                            PRODUCT, REPOSITORY, engine_version, observer_version)
from .formatting import LineReporter, Output, make_output

LOG = logging.getLogger("dstns.launcher")


class Back(Exception):
    """Leave the current menu."""


class FallbackApp:
    def __init__(self, args, caps: Capabilities, session: Session, *, rich: bool) -> None:
        self.args = args
        self.caps = caps
        self.session = session
        self.out = make_output(caps, rich=rich)
        self.reporter = LineReporter(self.out, verbose=getattr(args, "verbose", False))
        self.unicode = caps.unicode

    # -- framework ----------------------------------------------------------
    def run(self, initial: str = "home") -> int:
        try:
            if initial == "start":
                self.guard(lambda: self.start(self.args.run, ask=False))
            elif initial == "config":
                self.guard(self.configuration)
            elif initial == "logs":
                self.guard(self.logs)
            return self.home()
        except (KeyboardInterrupt, EOFError):
            self.out.write()
            return self.leave()

    def guard(self, action: Callable[[], object]) -> None:
        """Run a menu action; errors are explained and the menu continues."""
        try:
            action()
        except Back:
            pass
        except KeyboardInterrupt:
            self.out.write()
        except DSTNSLauncherError as exc:
            LOG.error("%s", exc, exc_info=True)
            self.explain(exc)
        except Exception as exc:  # noqa: BLE001 - keep the launcher usable after an unexpected failure
            LOG.critical("unexpected error in compatibility mode", exc_info=True)
            self.out.message(Level.ERROR, f"Unexpected error: {exc}")
            self.out.muted(f"  Details have been written to {PATHS.launcher_log}")

    def explain(self, exc: DSTNSLauncherError) -> None:
        self.out.write()
        self.out.message(Level.ERROR, str(exc))
        for line in (exc.remedy or "").splitlines():
            self.out.muted("  " + line)
        for line in (exc.detail or "").splitlines()[-12:]:
            self.out.muted("  " + line)
        self.out.muted(f"  Details have been written to {PATHS.launcher_log}")

    def choose(self, title: str, items: list[str], *, back: str = "Back") -> int:
        """Show a numbered menu; returns the 0-based choice, or raises Back."""
        while True:
            self.out.heading(title)
            self.out.rule()
            self.out.menu(items + [back])
            self.out.rule()
            answer = self.out.ask("Select")
            if answer.lower() in {"q", "b", "back", "esc"}:
                raise Back
            if answer.isdigit() and 1 <= int(answer) <= len(items) + 1:
                if int(answer) == len(items) + 1:
                    raise Back
                return int(answer) - 1
            self.out.message(Level.WARNING, f"Enter a number from 1 to {len(items) + 1}.")

    def pause(self) -> None:
        self.out.ask("Press Enter to continue")

    # -- home ----------------------------------------------------------------
    MENU = ["Start simulation", "Saved seeds", "Configuration", "Diagnostics", "Logs", "Tests", "Tools", "About"]

    def home(self) -> int:
        while True:
            self.header()
            items = list(self.MENU)
            running = self.session.handle is not None and self.session.handle.running()
            if running:
                items.insert(0, "Running simulation")
            try:
                choice = self.choose("Main menu", items, back="Exit")
            except Back:
                return self.leave()
            label = items[choice]
            action = {
                "Running simulation": self.monitor,
                "Start simulation": lambda: self.start(RunOptions(), ask=True),
                "Saved seeds": self.saved_seeds,
                "Configuration": self.configuration,
                "Diagnostics": self.diagnostics,
                "Logs": self.logs,
                "Tests": self.tests,
                "Tools": self.tools,
                "About": self.about,
            }[label]
            self.guard(action)

    def header(self) -> None:
        self.out.write()
        self.out.banner(f"{PRODUCT} {engine_version()}", FULL_NAME)
        self.out.heading("Status")
        try:
            configuration.load()
            self.out.status(State.PASS, "Configuration", "valid")
        except DSTNSLauncherError as exc:
            self.out.status(State.FAIL, "Configuration", str(exc))
        self.out.status(State.PASS if PATHS.server.exists() else State.WARNING, "Simulation core",
                        "built" if PATHS.server.exists() else "built automatically on first start")
        port = self.session.port or server.active_port()
        if port:
            current = simulation.status(port)
            self.out.status(State.PASS, "Server", f"port {port} · {current.lifecycle}")
        else:
            self.out.status(State.SKIPPED, "Server", "not running")

    def leave(self) -> int:
        handle = self.session.handle
        if handle and handle.managed and handle.running():
            try:
                if not self.out.confirm("The simulation is running. Stop it and exit?", default=False):
                    return self.home()
            except (KeyboardInterrupt, EOFError):
                pass
            self.out.message(Level.INFO, "Stopping the simulation")
            self.session.stop_server()
        self.out.line(f"{PRODUCT} launcher closed.")
        return 0

    # -- start and monitor ---------------------------------------------------
    def start(self, options: RunOptions, *, ask: bool) -> None:
        if ask:
            options = self.ask_run_options()
        self.out.heading("Starting a simulation")
        self.out.rule()
        world = self.session.launch(options, self.reporter, open_browser=self.args.open)
        if world is None and self.session.observed_existing:
            self.out.message(Level.INFO, "A run is already in progress; showing it")
        self.monitor()

    def ask_run_options(self) -> RunOptions:
        self.out.heading("New simulation")
        self.out.muted("Press Enter to accept a default. Leave the seed empty for a new one.")
        options = RunOptions()
        options.seed = self.out.ask("Seed") or None
        day = self.out.ask("Day type (auto/weekday/weekend)", "auto")
        options.day_type = day if day in {"weekday", "weekend", "auto"} else None
        if day not in {"weekday", "weekend", "auto"}:
            self.out.message(Level.WARNING, "Unknown day type; using the configured default")
        if not options.seed:
            options.location = self.out.ask("Location (a city generates a seed there; empty: the seed's own)") or None
            options.month = self.out.ask("Month (1-12 or a name; empty: the seed's own)") or None
        cached = simulation.cached_maps()
        hint = f" ({len(cached)} cached: e.g. {cached[0]})" if cached else ""
        map_choice = self.out.ask(f"Map: auto, or a file path{hint}", "auto")
        options.osm_file = None if map_choice == "auto" else map_choice
        save = self.out.ask("Save this configuration as (optional ID)")
        if save:
            options.save_seed = save
            options.description = self.out.ask("Description (optional)") or None
        configuration.start_request(options)  # validate before anything starts
        return options

    def monitor(self) -> None:
        port = self.session.port or server.active_port()
        if port is None:
            self.out.message(Level.INFO, "No simulation is running")
            return
        handle = self.session.handle
        while True:
            current = simulation.status(port)
            figures = simulation.metrics(port) if current.reachable else simulation.Metrics()
            self.out.heading("Simulation")
            self.out.rule()
            if not current.reachable:
                self.out.message(Level.WARNING, "The server is no longer reachable")
                return
            rows = [("State", current.lifecycle.capitalize()), ("Simulation time", f"{current.clock} / 24:00:00 ({current.fraction * 100:.1f}%)")]
            if self.session.world:
                world = self.session.world
                rows += [("Place", world.place), ("Seed", world.seed), ("Day", world.day_name)]
            elif current.seed:
                rows.append(("Seed", current.seed))
            if current.tick_rate is not None:
                rows.append(("Speed", f"{current.tick_rate:g}x"))
            if figures.vehicles is not None:
                rows.append(("Vehicles (modelled)", f"{figures.vehicles:,}"))
            if figures.congestion is not None:
                rows.append(("Congestion", f"{figures.congestion:.1f}%"))
            rows.append(("Observer", f"http://127.0.0.1:{port}/"))
            self.out.pairs(rows)
            if current.lifecycle == "COMPLETED":
                self.out.message(Level.SUCCESS, "The simulated day is complete")
            self.out.rule()
            self.out.muted("Enter refresh · p pause · r resume · o open observer · d restart the day")
            self.out.muted("s stop the simulation · b back to the menu")
            answer = self.out.ask("Action").lower()
            if answer in {"b", "back", "q"}:
                return
            try:
                if answer == "p":
                    simulation.control(port, "pause")
                elif answer == "r":
                    simulation.control(port, "play")
                elif answer == "d":
                    if self.out.confirm("Restart the same day from 00:00:00?", default=False):
                        simulation.control(port, "restart")
                elif answer == "o":
                    url = f"http://127.0.0.1:{port}/"
                    opened = simulation.open_in_browser(url)
                    self.out.message(Level.SUCCESS if opened else Level.WARNING,
                                     "Observer opened" if opened else "Open this address in your browser", url)
                elif answer == "s":
                    if self.out.confirm("Stop the simulation? The current run has not been saved.", default=False):
                        self.out.message(Level.INFO, "Stopping the simulation...")
                        if handle is None:
                            handle = server.ServerHandle(port, "127.0.0.1", {})
                            self.session.handle = handle
                        stopped = self.session.stop_server()
                        self.out.message(Level.SUCCESS if stopped else Level.ERROR,
                                         "Simulation stopped" if stopped else "The server did not stop")
                        return
            except DSTNSLauncherError as exc:
                self.explain(exc)

    # -- seeds ------------------------------------------------------------------
    def saved_seeds(self) -> None:
        while True:
            rows = seed_store.operate("list", {})
            self.out.heading("Saved seeds")
            if not rows:
                self.out.muted("No saved seeds yet. Save one when starting a simulation.")
                self.pause()
                return
            self.out.table(["ID", "Seed", "Created", "Description"],
                           [(r["id"], r["seed"], r["created_at"][:19].replace("T", " "), r["description"]) for r in rows])
            choice = self.choose("Choose a saved seed", [r["id"] for r in rows])
            name = rows[choice]["id"]
            action = self.choose(name, ["Start it", "Inspect", "Delete"])
            if action == 0:
                self.start(RunOptions(saved_seed=name), ask=False)
                return
            if action == 1:
                record = seed_store.operate("inspect", {"id": name})
                config = record["config"]
                self.out.pairs([("Seed", record["seed"]), ("Created", record["created_at"]),
                                ("Description", record["description"] or "-"), ("Day", "weekend" if config.get("day") == 1 else "weekday"),
                                ("Map", config["map"]["osm_file"]), ("Map selection", record["map_version"])])
                self.pause()
            if action == 2 and self.out.confirm(f"Delete the saved seed {name}?", default=False):
                seed_store.operate("delete", {"id": name})
                self.out.message(Level.SUCCESS, f"Deleted {name}")

    # -- configuration ------------------------------------------------------------
    def configuration(self) -> None:
        config = configuration.load()
        original = repr(config)
        while True:
            dirty = repr(config) != original
            labels = [f"{f.category:8} {f.label:18} {f.display(f.get(config))} {f.unit}".rstrip() for f in configuration.FIELDS]
            self.out.heading("Configuration" + ("   * UNSAVED" if dirty else ""))
            self.out.muted("config/defaults.json")
            items = labels + ["Save changes"]
            try:
                choice = self.choose("Choose a setting to change", items)
            except Back:
                if dirty and not self.unsaved(config):
                    continue
                return
            if choice == len(labels):
                configuration.save(config)
                original = repr(config)
                self.out.message(Level.SUCCESS, "Configuration saved")
                continue
            field = configuration.FIELDS[choice]
            self.out.muted(field.help)
            if field.kind is configuration.Kind.CHOICE:
                hint = "/".join(label for label, _ in field.choices)
            elif field.kind is configuration.Kind.BOOLEAN:
                hint = "on/off"
            elif field.minimum is not None:
                hint = field.range_text().rstrip(".").replace("Must be ", "")
            else:
                hint = ""
            text = self.out.ask(f"{field.label}{f' ({hint})' if hint else ''}", field.display(field.get(config)))
            try:
                value = field.parse(text)
                problem = configuration.check_field(field, value, config)
                if problem:
                    raise configuration.ConfigurationError(problem)
            except configuration.ConfigurationError as exc:
                self.out.message(Level.ERROR, f"{field.label}: {exc}")
                continue
            field.set(config, value)

    def unsaved(self, config) -> bool:
        """Returns True when it is fine to leave."""
        choice = self.choose("Unsaved changes: configuration has been modified", ["Save and continue", "Discard changes"],
                             back="Cancel")
        if choice == 0:
            configuration.save(config)
            self.out.message(Level.SUCCESS, "Configuration saved")
        return True

    # -- diagnostics, logs, tests, tools -------------------------------------------
    def diagnostics(self) -> None:
        suites = self.out.confirm("Also run the test suites (takes a minute)?", default=False)
        self.out.heading("Diagnostics")
        self.out.rule()
        items = environment.checks(suites=suites)
        environment.run_checks(items)
        for check in items:
            self.out.status(check.outcome.state, check.name, check.outcome.value)
            if check.outcome.state in (State.FAIL, State.WARNING):
                for line in (check.outcome.detail or "").splitlines()[:3]:
                    self.out.muted("          " + line)
                if check.outcome.remedy:
                    self.out.muted("          " + check.outcome.remedy)
        blocking = environment.blocking(items)
        self.out.rule()
        if blocking:
            self.out.message(Level.ERROR, f"{len(blocking)} required check(s) failed; a simulation cannot start")
        else:
            self.out.message(Level.SUCCESS, "Ready to run")
        self.out.muted(f"Terminal: {self.caps.summary()}")
        self.pause()

    def logs(self) -> None:
        keys = list(logs.SOURCES)
        while True:
            choice = self.choose("Logs", [logs.SOURCES[key] for key in keys])
            key = keys[choice]
            if key == "system":
                lines = logs.system_tail(60)
                if lines is None:
                    self.out.message(Level.INFO, "No system log yet")
                for line in lines or []:
                    self.out.line(line)
            else:
                table = logs.journal(key, 40)
                if table is None:
                    self.out.message(Level.INFO, "No runtime database yet")
                elif not table.rows:
                    self.out.message(Level.INFO, "No log records found")
                else:
                    self.out.table(table.columns, table.rows, max_width=40)
            self.pause()

    def tests(self) -> None:
        scopes = list(testing.SCOPES)
        choice = self.choose("Tests", [f"{scope}" for scope in scopes])
        results = testing.run(scopes[choice], self.reporter)
        failed = [result for result in results if not result.passed]
        self.out.message(Level.ERROR if failed else Level.SUCCESS,
                         f"{len(failed)} of {len(results)} stage(s) failed" if failed else f"All {len(results)} stages passed")
        self.pause()

    def tools(self) -> None:
        choice = self.choose("Tools", ["Check the SUMO toolchain", "Rebuild the observer", "Reset runtime data"])
        if choice == 0:
            self.out.pairs(sumo.run_standalone(self.reporter).items())
        elif choice == 1:
            from ..core import build

            build.execute(build.plan(force_ui=True), self.reporter)
        elif choice == 2:
            for path in maintenance.describe():
                self.out.muted("  " + path)
            if self.out.confirm("Delete these runtime files? Maps, saved seeds and configuration are kept.", default=False):
                maintenance.reset(self.reporter)
        self.pause()

    def about(self) -> None:
        self.out.heading(PRODUCT)
        self.out.line(FULL_NAME)
        self.out.write()
        self.out.pairs([("Version", engine_version()), ("Observer", observer_version()),
                        ("Copyright", "© 2026 Varun Karthic" if self.unicode else "(C) 2026 Varun Karthic"),
                        ("License", LICENSE_NAME), ("SPDX", LICENSE_SPDX)], width=12)
        self.out.write()
        self.out.line("Map data")
        self.out.line(f"  {OSM_ATTRIBUTION if self.unicode else '(C) OpenStreetMap contributors'}")
        self.out.line(f"  OpenStreetMap data is available under the {OSM_LICENSE}.")
        self.out.write()
        self.out.pairs([("Project", REPOSITORY), ("Documentation", DOCUMENTATION)], width=14)
        self.pause()


def run_fallback(args, caps: Capabilities, session: Session, initial: str = "home", *, rich: bool = True) -> int:
    LOG.info("compatibility mode (%s)", "rich" if rich else "plain")
    return FallbackApp(args, caps, session, rich=rich).run(initial)
