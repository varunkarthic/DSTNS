# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Tests and Tools: long operations with live step status and output."""
from __future__ import annotations

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import RichLog, Static

from ...core import build, maintenance, sumo, testing
from ...core.environment import State
from ...core.errors import DSTNSLauncherError
from ...core.reporting import Level
from ..base import Page, TuiReporter, confirm
from ..widgets import Activity, Key, Menu, MenuItem, Row, Rule, StatusTable


class TaskScreen(Page):
    """A menu of operations; the chosen one runs with its steps and output shown."""

    KEYS = [Key("Enter", "Run", "Run", essential=True), Key("Esc", "Back", "Back", essential=True)]
    ITEMS: list[MenuItem] = []

    def __init__(self) -> None:
        super().__init__()
        self.busy = False
        self.steps: dict[str, Row] = {}

    def compose_body(self) -> ComposeResult:
        with Horizontal(id="columns"):
            with Vertical(id="sidebar"):
                yield Menu(self.ITEMS, show_hints=False, id="tasks")
            with Vertical(id="content"):
                yield Static("", id="task-title", classes="panel-title")
                yield Rule()
                yield Activity(id="activity")
                yield StatusTable(id="steps", name_width=40)
                yield Static("", id="task-result", classes="hint")
                yield Rule("Output")
                yield RichLog(id="output", min_width=10, wrap=True, max_lines=3000)

    def on_mount(self) -> None:
        self.query_one("#tasks", Menu).focus()

    def on_menu_highlighted(self, event: Menu.Highlighted) -> None:
        if not self.busy:
            self.query_one("#task-title", Static).update(event.item.label.upper())
            self.query_one("#task-result", Static).update(Text(event.item.hint, style="#8CA7B2"))

    def on_menu_selected(self, event: Menu.Selected) -> None:
        if self.busy:
            self.notify("Wait for the current operation to finish.", timeout=3)
            return
        self.begin(event.item)

    def begin(self, item: MenuItem) -> None:
        self.busy = True
        self.steps = {}
        self.query_one("#steps", StatusTable).set_rows([])
        self.query_one("#output", RichLog).clear()
        self.query_one("#task-title", Static).update(item.label.upper())
        self.query_one("#task-result", Static).update("")
        self.header.set_state(State.RUNNING, "working")
        self.query_one("#activity", Activity).start(item.label)
        self.execute(item.key)

    def reporter(self) -> TuiReporter:
        return TuiReporter(self.app, on_message=self.message, on_step=self.step, on_output=self.output)

    def message(self, level: Level, text: str, detail: str = "") -> None:
        style = {Level.ERROR: "#F04444", Level.WARNING: "#F5B942", Level.SUCCESS: "#32D583"}.get(level, "#8CA7B2")
        self.query_one("#output", RichLog).write(Text(text + (f" · {detail}" if detail else ""), style=style))

    def step(self, state: str, title: str, summary: str) -> None:
        mapping = {"running": State.RUNNING, "pass": State.PASS, "fail": State.FAIL}
        self.steps[title] = Row(title, "" if state == "running" else summary, mapping[state])
        self.query_one("#steps", StatusTable).set_rows(list(self.steps.values()))
        if state == "running":
            self.query_one("#activity", Activity).start(title)

    def output(self, text: str) -> None:
        log = self.query_one("#output", RichLog)
        for line in text.splitlines():
            log.write(Text(line, style="#8CA7B2"))

    def done(self, ok: bool, summary: str) -> None:
        self.busy = False
        self.query_one("#activity", Activity).stop()
        self.header.set_state(State.PASS if ok else State.FAIL, "done" if ok else "failed")
        self.query_one("#task-result", Static).update(Text(summary, style="#32D583" if ok else "#F04444"))

    @work(thread=True, exclusive=True, group="task")
    def execute(self, key: str) -> None:
        try:
            ok, summary = self.perform(key)
        except DSTNSLauncherError as exc:
            ok, summary = False, str(exc) + (f"\n{exc.remedy}" if exc.remedy else "")
        except Exception as exc:  # noqa: BLE001 - reported on screen; the launcher log has the traceback
            import logging

            logging.getLogger("dstns.launcher").exception("task %s failed", key)
            ok, summary = False, f"Unexpected error: {exc}"
        self.app.call_from_thread(self.done, ok, summary)

    def perform(self, key: str) -> tuple[bool, str]:
        raise NotImplementedError


class TestsScreen(TaskScreen):
    TITLE_TEXT = "Tests"
    ITEMS = [
        MenuItem("unit", "Native suites", "CTest: unit, property, replay, performance and HTTP suites."),
        MenuItem("api", "HTTP contract", "The API smoke test against a private server."),
        MenuItem("replay", "Reproducibility", "dstns_replay_verify: one seed run twice must match exactly."),
        MenuItem("ui", "Observer", "The observer's Vitest suites."),
        MenuItem("benchmark", "Benchmark", "Routing and snapshot timings on this machine."),
        MenuItem("sumo", "SUMO", "The SUMO integration smoke test (needs SUMO)."),
        MenuItem("all", "Everything", "Configure, build, then every stage above and the production bundle."),
    ]

    def perform(self, key: str) -> tuple[bool, str]:
        results = testing.run(key, self.reporter())
        failed = [result for result in results if not result.passed]
        if failed:
            return False, f"{len(failed)} of {len(results)} stage(s) failed: {failed[0].title}."
        return True, f"All {len(results)} stage(s) passed."


class ToolsScreen(TaskScreen):
    TITLE_TEXT = "Tools"
    ITEMS = [
        MenuItem("sumo", "Check SUMO toolchain", "Export a synthetic grid, convert it and run SUMO on it."),
        MenuItem("observer", "Rebuild the observer", "Build the observer bundle again from its sources."),
        MenuItem("reset", "Reset runtime data", "Delete logs, the journal, checkpoints and temporary files. "
                                                 "Maps, saved seeds and configuration are kept."),
    ]

    def on_menu_selected(self, event: Menu.Selected) -> None:
        if event.item.key == "reset" and not self.busy:
            listing = "\n".join(maintenance.describe())

            def decided(choice: str | None) -> None:
                if choice == "yes":
                    self.begin(event.item)

            self.app.push_screen(confirm("Reset runtime data?", f"These will be deleted:\n{listing}", "Reset"), decided)
            return
        super().on_menu_selected(event)

    def perform(self, key: str) -> tuple[bool, str]:
        reporter = self.reporter()
        if key == "sumo":
            summary = sumo.run_standalone(reporter)
            return True, " · ".join(f"{name}: {value}" for name, value in summary.items())
        if key == "observer":
            build.execute(build.plan(force_ui=True), reporter)
            return True, "The observer bundle was rebuilt."
        maintenance.reset(reporter)
        return True, "Runtime data cleared. Maps, saved seeds and configuration were kept."
