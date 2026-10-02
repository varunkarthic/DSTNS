# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Running simulation: start-up progress, then the engine's own figures and log.

The terminal does not try to draw the city; the observer does that. This screen
shows what the engine reports, refreshed a few times a second, so the interface
never competes with the simulation for time.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import ProgressBar, RichLog, Static

from ...core import logs, server, simulation
from ...core.configuration import RunOptions
from ...core.environment import State
from ...core.errors import DSTNSLauncherError
from ...core.reporting import Level
from ...core.terminal import Layout, layout_for
from ..base import Page, TuiReporter, confirm, error_dialog
from ..widgets import Activity, Key, Row, Rule, StatusTable

POLL = 0.25          # status refresh, seconds
FIGURES_EVERY = 1.0  # network totals
USAGE_EVERY = 2.0    # CPU and memory of a server we started
LEVEL_STYLE = {Level.INFO: "#8CA7B2", Level.SUCCESS: "#32D583", Level.WARNING: "#F5B942", Level.ERROR: "#F04444"}


def stop_in_background(app, then=None) -> None:
    """Stop the session's server off the interface thread, then call ``then``."""

    def work_() -> None:
        stopped = app.session.stop_server()
        if then is not None:
            app.call_from_thread(then)
        elif not stopped:
            app.call_from_thread(app.notify, "The server did not stop; see logs/launcher.log.", severity="error")

    threading.Thread(target=work_, daemon=True).start()


class RunningScreen(Page):
    TITLE_TEXT = "Running Simulation"
    LIVE_KEYS = [Key("Space", "Pause/resume", "Pause", essential=True), Key("o", "Open observer", "Observer"),
                 Key("s", "Stop", "Stop", essential=True), Key("Esc", "Dashboard", "Back", essential=True),
                 Key("f", "Follow log", "Follow"), Key("c", "Clear log", "Clear")]
    KEYS = LIVE_KEYS
    BINDINGS = Page.BINDINGS + [
        Binding("space", "toggle", "Pause or resume", show=False),
        Binding("p", "toggle", "Pause or resume", show=False),
        Binding("o", "observer", "Open observer", show=False),
        Binding("s", "stop", "Stop", show=False),
        Binding("f", "follow", "Follow log", show=False),
        Binding("c", "clear_log", "Clear log", show=False),
        Binding("end", "latest", "Latest", show=False),
        Binding("b", "back", "Dashboard", show=False),
    ]

    def __init__(self, *, options: RunOptions | None) -> None:
        super().__init__()
        self.options = options
        self.phase = "preparing" if options is not None else "live"
        self.port: int | None = None
        self.status: simulation.Status | None = None
        self.figures = simulation.Metrics()
        self.usage: tuple[float, float] | None = None
        self.follower = logs.Follower()
        self.misses = 0
        self.last_figures = 0.0
        self.last_usage = 0.0
        self.completed_shown = False
        self.stopping = False
        self.cancel = threading.Event()

    def compose_body(self) -> ComposeResult:
        with Vertical(classes="body"):
            yield Static("", id="phase", classes="section-title")
            yield Rule()
            yield StatusTable(id="facts", name_width=18)
            with Horizontal(id="progress-line"):
                yield Static("Progress", id="progress-label", classes="muted")
                yield ProgressBar(total=100, show_eta=False, id="progress")
            yield Activity(id="activity", classes="hint")
            yield Rule("Live log")
            yield RichLog(id="log", min_width=10, wrap=True, max_lines=2000, markup=False)
            yield Static("", id="usage", classes="dim hide-small")

    def on_mount(self) -> None:
        log = self.query_one("#log", RichLog)
        for line in self.app.run_log:
            log.write(line)
        self.query_one("#progress-line").styles.height = 1
        self.query_one("#progress-label").styles.width = 19
        if self.phase == "preparing":
            self.header.set_state(State.RUNNING, "starting")
            self.set_keys([Key("Esc", "Cancel", "Cancel", essential=True), Key("f", "Follow log", "Follow")])
            self.query_one("#phase", Static).update("STARTING")
            self.query_one("#progress-line").display = False
            self.query_one("#activity", Activity).start("Preparing the simulation")
            self.launch()
        else:
            self.port = self.app.session.port if self.app.session.handle and self.app.session.handle.running() else None
            self.port = self.port or server.active_port()
            self.query_one("#phase", Static).update("SIMULATION")
        self.set_interval(POLL, self.poll)

    def on_resize(self) -> None:
        self.call_after_refresh(self.render_facts)

    # -- logging --------------------------------------------------------------------
    def say(self, level: Level, text: str, detail: str = "") -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        line = f"[{stamp}] {text}" + (f" · {detail}" if detail else "")
        self.app.run_log.append(line)
        self.query_one("#log", RichLog).write(Text(line, style=LEVEL_STYLE[level]))
        if self.phase == "preparing" and level is Level.INFO:
            self.query_one("#activity", Activity).start(text)

    def step(self, state: str, title: str, summary: str) -> None:
        if state == "running":
            self.query_one("#activity", Activity).start(title)
        else:
            self.say(Level.SUCCESS if state == "pass" else Level.ERROR, title, summary)

    def output(self, text: str) -> None:
        log = self.query_one("#log", RichLog)
        for line in text.splitlines()[-20:]:
            log.write(Text("    " + line, style="#58717C"))

    def progress(self, label: str, done: float, total: float | None) -> None:
        bar = self.query_one("#progress", ProgressBar)
        self.query_one("#progress-line").display = bool(total and total > 0)
        self.query_one("#progress-label", Static).update("Map download")
        if total and total > 0:
            bar.update(total=total, progress=done)
            text = f"{label}: {done / 1048576:.1f} of {total / 1048576:.1f} MiB"
        else:
            text = f"{label}: {done / 1048576:.1f} MiB" if done else f"{label}..."
        self.query_one("#activity", Activity).start(text)

    def progress_done(self) -> None:
        self.query_one("#progress", ProgressBar).update(total=100, progress=0)
        self.query_one("#progress-line").display = False
        self.query_one("#activity", Activity).start("Preparing the world")

    # -- start-up ----------------------------------------------------------------------
    @work(thread=True, exclusive=True, group="launch")
    def launch(self) -> None:
        reporter = TuiReporter(self.app, on_message=self.say, on_step=self.step, on_output=self.output,
                               on_progress=self.progress, on_progress_done=self.progress_done)
        try:
            self.app.session.launch(self.options, reporter, open_browser=bool(self.app.args.open), cancel=self.cancel)
        except DSTNSLauncherError as exc:
            self.app.call_from_thread(self.launch_failed, exc)
            return
        except Exception as exc:  # noqa: BLE001 - shown as a recoverable error; the launcher log has the traceback
            import logging

            logging.getLogger("dstns.launcher").exception("start-up failed")
            self.app.call_from_thread(self.launch_failed, exc)
            return
        self.app.call_from_thread(self.launched)

    def launched(self) -> None:
        self.phase = "live"
        self.port = self.app.session.port
        self.query_one("#phase", Static).update("SIMULATION")
        self.query_one("#activity", Activity).stop()
        self.query_one("#progress-label", Static).update("Progress")
        self.query_one("#progress-line").display = True
        self.set_keys(self.LIVE_KEYS)
        self.poll()

    def launch_failed(self, exc: BaseException) -> None:
        self.query_one("#activity", Activity).stop()
        self.query_one("#progress-line").display = False
        if self.cancel.is_set():
            self.app.pop_screen()
            return
        self.phase = "failed"
        self.header.set_state(State.FAIL, "failed")
        self.say(Level.ERROR, str(exc))

        def decided(choice: str | None) -> None:
            if choice == "retry":
                self.app.goto(RunningScreen(options=self.options))
            elif choice == "diagnostics":
                from .diagnostics import DiagnosticsScreen

                self.app.goto(DiagnosticsScreen())
            else:
                self.app.pop_screen()

        self.app.push_screen(error_dialog("Unable to start the simulation", exc,
                                          [("retry", "Retry"), ("diagnostics", "Diagnostics"), ("menu", "Return to menu")]),
                             decided)

    # -- live status -------------------------------------------------------------------
    def poll(self) -> None:
        if self.phase == "live" and self.port and not self.stopping:
            self.fetch()

    @work(thread=True, exclusive=True, group="running-poll")
    def fetch(self) -> None:
        port = self.port
        current = simulation.status(port)
        now = time.monotonic()
        figures = usage = None
        if current.reachable and now - self.last_figures >= FIGURES_EVERY:
            self.last_figures = now
            figures = simulation.metrics(port)
        handle = self.app.session.handle
        if handle and handle.process is not None and now - self.last_usage >= USAGE_EVERY:
            self.last_usage = now
            usage = simulation.server_usage(handle.process.pid)
        lines = self.follower.read()
        exited = handle.exit_code() if handle and handle.process is not None else None
        self.app.call_from_thread(self.show, current, figures, usage, lines, exited)

    def show(self, current: simulation.Status, figures, usage, lines: list[str], exited: int | None) -> None:
        if figures is not None:
            self.figures = figures
        if usage is not None:
            self.usage = usage
        log = self.query_one("#log", RichLog)
        for line in lines:
            self.app.run_log.append(line)
            log.write(Text(line, style="#8CA7B2" if "[INFO]" in line else "#F5B942"))
        if not current.reachable:
            self.misses += 1
            if exited is not None or self.misses >= 8:
                self.server_gone(exited)
            return
        self.misses = 0
        self.status = current
        self.render_facts()
        if current.lifecycle == "COMPLETED" and not self.completed_shown:
            self.completed_shown = True
            from .completion import CompletionScreen

            self.app.goto(CompletionScreen(world=self.app.session.world, status=current, port=self.port))

    def render_facts(self) -> None:
        current, figures, world = self.status, self.figures, self.app.session.world
        if current is None:
            return
        state = {"RUNNING": State.PASS, "PAUSED": State.WARNING, "SEEKING": State.RUNNING}.get(current.lifecycle, State.PENDING)
        self.header.set_state(state if current.lifecycle != "RUNNING" else State.RUNNING, current.lifecycle.lower())
        rows = []
        if world:
            rows += [Row("Place", world.place), Row("Seed", world.seed), Row("Day", world.day_name)]
        elif current.seed:
            rows.append(Row("Seed", current.seed))
        rows.append(Row("Simulation time", f"{current.clock} / 24:00:00"))
        rows.append(Row("State", current.lifecycle.capitalize()))
        if current.tick_rate is not None:
            rows.append(Row("Speed", f"{current.tick_rate:g}{'×' if self.app.unicode else 'x'}"))
        if figures.vehicles is not None:
            rows.append(Row("Vehicles", f"{figures.vehicles:,} modelled · {figures.halting or 0:,} halting"))
        if figures.congestion is not None:
            rows.append(Row("Congestion", f"{figures.congestion:.1f}% (15-min average {figures.congestion_average or 0:.1f}%)"))
        if figures.closed_roads is not None:
            rows.append(Row("Roads", f"{figures.flooded_roads or 0} flooded · {figures.closed_roads} closed"))
        if figures.storms is not None:
            rows.append(Row("Storms", f"{figures.storms} active"))
        rows.append(Row("Observer", f"http://127.0.0.1:{self.port}/"))
        handle = self.app.session.handle
        rows.append(Row("Server", f"port {self.port} · {'started by this launcher' if handle and handle.managed else 'already running'}"))
        if layout_for(*self.app.size) is Layout.SMALL:
            # Keep progress and live output visible at 50x15. Full telemetry
            # returns on resize and remains available in the observer.
            essential = {"Place", "Seed", "Simulation time", "State", "Speed"}
            rows = [row for row in rows if row.name in essential]
        self.query_one("#facts", StatusTable).set_rows(rows)
        self.query_one("#progress", ProgressBar).update(total=100, progress=round(current.fraction * 100, 1))
        parts = []
        if self.usage:
            parts.append(f"CPU {self.usage[0]:.0f}%")
            parts.append(f"RAM {self.usage[1]:.0f} MiB")
        remaining = simulation.remaining_wall_seconds(current, figures.target_rate)
        if remaining is not None:
            minutes, seconds = divmod(int(remaining), 60)
            parts.append(f"Day ends in {minutes}m {seconds:02d}s")
        self.query_one("#usage", Static).update("      ".join(parts))

    def server_gone(self, exited: int | None) -> None:
        if self.stopping or self.phase != "live":
            return
        self.phase = "failed"
        self.header.set_state(State.FAIL, "stopped")
        reason = (f"The server exited with status {exited}." if exited not in (None, 0)
                  else "The server stopped." if exited == 0 else "The server is no longer reachable.")
        self.say(Level.ERROR, reason)
        error = DSTNSLauncherError(reason, remedy="Inspect the logs, or start a new simulation.")

        def decided(choice: str | None) -> None:
            if choice == "logs":
                from .logs import LogsScreen

                self.app.goto(LogsScreen())
            elif choice == "retry" and self.options is not None:
                self.app.goto(RunningScreen(options=self.options))
            else:
                self.app.pop_screen()

        actions = [("logs", "Inspect logs"), ("menu", "Return to menu")]
        if self.options is not None:
            actions.insert(0, ("retry", "Start again"))
        self.app.push_screen(error_dialog("Simulation stopped", error, actions), decided)

    # -- controls ------------------------------------------------------------------------
    def action_toggle(self) -> None:
        if self.phase != "live" or not self.status:
            return
        action = "pause" if self.status.lifecycle == "RUNNING" else "play"
        self.control(action)

    @work(thread=True, group="control")
    def control(self, action: str) -> None:
        try:
            simulation.control(self.port, action)
            self.app.call_from_thread(self.say, Level.INFO, "Paused" if action == "pause" else "Resumed")
        except DSTNSLauncherError as exc:
            self.app.call_from_thread(self.say, Level.ERROR, str(exc))

    def action_observer(self) -> None:
        if self.port:
            url = f"http://127.0.0.1:{self.port}/"
            threading.Thread(target=simulation.open_in_browser, args=(url,), daemon=True).start()
            self.say(Level.INFO, "Opening the observer", url)

    def action_stop(self) -> None:
        if self.phase != "live" or self.stopping:
            return

        def decided(choice: str | None) -> None:
            if choice == "yes":
                self.stopping = True
                self.header.set_state(State.RUNNING, "stopping")
                self.query_one("#activity", Activity).start("Stopping simulation")
                self.say(Level.INFO, "Stopping simulation...")
                if self.app.session.handle is None and self.port:
                    self.app.session.handle = server.ServerHandle(self.port, "127.0.0.1", {})
                stop_in_background(self.app, then=self.stopped)

        self.app.push_screen(confirm("Stop Simulation?", "The current simulation has not completed. Stopping ends "
                                     "the run and shuts the server down.", "Stop"), decided)

    def stopped(self) -> None:
        self.query_one("#activity", Activity).stop()
        handle = self.app.session.handle
        if handle and handle.running():
            self.stopping = False
            self.say(Level.ERROR, "The server did not stop")
            self.header.set_state(State.FAIL, "still running")
            return
        self.say(Level.SUCCESS, "Simulation stopped")
        self.app.session.handle = None
        self.app.pop_screen()
        self.app.notify("Simulation stopped.", timeout=4)

    def action_follow(self) -> None:
        log = self.query_one("#log", RichLog)
        log.auto_scroll = not log.auto_scroll
        if log.auto_scroll:
            log.scroll_end(animate=False)
        self.notify(f"Log follow {'on' if log.auto_scroll else 'off'}", timeout=2)

    def action_clear_log(self) -> None:
        # Only the view: system.log and the journal are untouched.
        self.query_one("#log", RichLog).clear()
        self.app.run_log.clear()

    def action_latest(self) -> None:
        self.query_one("#log", RichLog).scroll_end(animate=False)

    def action_back(self) -> None:
        if self.phase == "preparing":
            def decided(choice: str | None) -> None:
                if choice == "yes":
                    self.cancel.set()
                    self.query_one("#activity", Activity).start("Cancelling start-up")
                    self.say(Level.WARNING, "Cancelling start-up...")

            self.app.push_screen(confirm("Cancel start-up?", "The world is still being prepared.", "Cancel start-up",
                                         "Keep waiting"), decided)
            return
        self.app.pop_screen()
