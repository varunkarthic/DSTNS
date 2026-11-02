# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Applications: see them, run them, change them, and decide on what the Fabric API proposes."""
from __future__ import annotations

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Input, Select, Static, Switch, TextArea

from ...core import apps as catalogue
from ...core import fabric, server
from ...core.environment import State
from ...core.errors import ConfigurationError, DSTNSLauncherError
from ...core.supervisor import Phase, tail
from ..base import ChoiceDialog, Page, confirm
from ..widgets import FieldRow, Key, Menu, MenuItem, Row, StatusTable

PHASES = {Phase.WAITING: State.PENDING, Phase.PREPARING: State.RUNNING, Phase.STARTING: State.RUNNING, Phase.READY: State.PASS, Phase.FAILED: State.FAIL, Phase.STOPPED: State.SKIPPED}
PHASE_WORDS = {Phase.WAITING: "Waiting", Phase.PREPARING: "Preparing", Phase.STARTING: "Starting", Phase.READY: "Running", Phase.FAILED: "Failed", Phase.STOPPED: "Stopped"}


class AppsScreen(Page):
    TITLE_TEXT = "Applications"
    KEYS = [Key("Enter", "Run or stop", "Run", essential=True), Key("a", "Add", "Add", essential=True), Key("e", "Change", "Change"), Key("d", "Remove", "Remove"), Key("Esc", "Back", "Back", essential=True)]
    BINDINGS = Page.BINDINGS + [Binding("a", "add", "Add", show=False), Binding("e", "change", "Change", show=False), Binding("d", "remove", "Remove", show=False)]

    def __init__(self) -> None:
        super().__init__()
        self.server_port: int | None = None
        self.connected: dict[str, dict] = {}
        self.waiting: list[dict] = []

    def compose_body(self) -> ComposeResult:
        with Horizontal(id="columns"):
            with Vertical(id="sidebar") as side:
                side.border_title = "Applications"
                yield Menu([], id="apps")
            with VerticalScroll(id="content") as content:
                content.border_title = "Details"
                yield Static("", id="panel-title", classes="panel-title")
                yield StatusTable(id="facts", name_width=18)
                yield Static("", id="panel-text", classes="hint")

    def on_mount(self) -> None:
        self.query_one("#apps", Menu).focus()
        self.rebuild()
        self.poll()
        self.set_interval(1.5, self.poll)

    def on_screen_resume(self) -> None:
        self.rebuild()

    @work(thread=True, exclusive=True, group="apps-poll")
    def poll(self) -> None:
        port = self.app.session.port if self.app.session.handle and self.app.session.handle.running() else None
        port = port or server.active_port()
        connected = {item["id"]: item for item in fabric.apps(port)} if port else {}
        waiting = fabric.proposals(port) if port else []
        self.app.call_from_thread(self.polled, port, connected, waiting)

    def polled(self, port: int | None, connected: dict, waiting: list) -> None:
        if not self.is_mounted:
            return
        self.server_port, self.connected, self.waiting = port, connected, waiting
        self.rebuild()

    def running(self, app_id: str):
        supervisor = self.app.session.supervisor
        return supervisor.running.get(app_id) if supervisor else None

    def rebuild(self) -> None:
        try:
            entries = catalogue.load()
        except DSTNSLauncherError as exc:
            self.query_one("#panel-text", Static).update(Text(str(exc), style="#EF5A64"))
            return
        items = []
        for app in entries.values():
            running = self.running(app.id)
            marker = "● " if running and running.phase is Phase.READY else "  "
            items.append(MenuItem(f"app:{app.id}", marker + app.title))
        for proposal in self.waiting:
            items.append(MenuItem(f"proposal:{proposal['id']}", f"? {proposal['id']}"))
        items.append(MenuItem("add", "+ Add an application"))
        menu = self.query_one("#apps", Menu)
        if [(i.key, i.label) for i in items] != [(i.key, i.label) for i in menu.items]:
            menu.set_items(items)
        self.show(menu.current)

    def on_menu_highlighted(self, event: Menu.Highlighted) -> None:
        self.show(event.item)

    def show(self, item: MenuItem | None) -> None:
        if item is None or not self.is_mounted:
            return
        title, rows, text = self.describe(item.key)
        self.query_one("#panel-title", Static).update(title)
        self.query_one("#facts", StatusTable).set_rows(rows)
        self.query_one("#panel-text", Static).update(text)

    def describe(self, key: str) -> tuple[str, list[Row], str]:
        if key == "add":
            return "Add an application", [], "\nA command or two that start your program. Once added, it can start alongside any simulation, and the simulation waits until it is ready."
        kind, _, app_id = key.partition(":")
        if kind == "proposal":
            proposal = next((item for item in self.waiting if item["id"] == app_id), None)
            if not proposal:
                return app_id, [], ""
            rows = [Row("Proposed by", str(proposal.get("proposed_by", "unknown")))]
            rows += [Row(f"Command {n + 1}", command) for n, command in enumerate(proposal["spec"]["commands"])]
            return app_id, rows, "\nNothing has run. Enter reads it through with you before anything can."
        app = catalogue.load().get(app_id)
        if app is None:
            return app_id, [], ""
        rows = []
        running = self.running(app_id)
        if running:
            rows.append(Row("Launcher", PHASE_WORDS[running.phase], PHASES[running.phase], running.detail))
        else:
            rows.append(Row("Launcher", "Not started", State.SKIPPED))
        connected = self.connected.get(app_id)
        if connected:
            rows.append(Row("Fabric", str(connected.get("state", "")).title(), State.PASS if connected.get("state") == "active" else State.PENDING))
            pending = (connected.get("capabilities") or {}).get("pending", [])
            if pending:
                rows.append(Row("Needs permission", ", ".join(pending), State.WARNING))
        else:
            rows.append(Row("Fabric", "Not connected" if self.server_port else "No server running", State.SKIPPED))
        rows += [Row(f"Command {n + 1}" if len(app.commands) > 1 else "Command", command) for n, command in enumerate(app.commands)]
        rows += [Row("Runs in", app.cwd), Row("Ready when", "It says so" if app.ready == "fabric" else app.ready), Row("Starts", "With every run" if app.autostart else "When chosen"), Row("Required", "Yes" if app.required else "No")]
        rows += [Row("Problem", problem, State.FAIL) for problem in catalogue.problems(app)]
        hint = "\nEnter stops it." if running and running.phase in (Phase.READY, Phase.STARTING, Phase.PREPARING) else "\nEnter starts it now, if a server is running."
        if running and running.phase is Phase.FAILED:
            hint = f"\n{tail(running.log)}" + hint
        return app.title, rows, hint

    def on_menu_selected(self, event: Menu.Selected) -> None:
        key = event.item.key
        if key == "add":
            return self.action_add()
        kind, _, app_id = key.partition(":")
        if kind == "proposal":
            return self.decide(app_id)
        running = self.running(app_id)
        if running and running.phase in (Phase.READY, Phase.STARTING, Phase.PREPARING):
            self.app.session.supervisor.stop(app_id)
            self.notify(f"Stopping {running.app.title}", timeout=2)
        elif self.server_port is None:
            self.notify("No server is running. Start a simulation first, and choose this application.", severity="warning", timeout=4)
        else:
            self.app.session.supervise(self.server_port).start(catalogue.get(app_id))
            self.notify("Starting", timeout=2)
        self.rebuild()

    def decide(self, app_id: str) -> None:
        proposal = next((item for item in self.waiting if item["id"] == app_id), None)
        if not proposal:
            return
        spec = proposal["spec"]
        message = Text()
        message.append(f"Proposed by the {proposal.get('proposed_by', 'unknown')}. These will run on this machine, as you:\n\n", style="#E6F0F7")
        for command in spec["commands"]:
            message.append(f"  {command}\n", style="#37D7FF")

        def decided(choice: str | None) -> None:
            if choice == "approve":
                try:
                    catalogue.put(catalogue.App(id=app_id, name=str(spec.get("name", "")), commands=list(spec["commands"]), cwd=str(spec.get("cwd", ".")),
                                                env=dict(spec.get("env") or {}), ready=str(spec.get("ready", "fabric")), timeout_s=float(spec.get("timeout_s", 60)), restart=str(spec.get("restart", "never"))))
                except ConfigurationError as exc:
                    self.notify(str(exc), severity="error")
                    return
            if choice in {"approve", "reject"}:
                fabric.withdraw(self.server_port, app_id)
                self.poll()

        self.app.open(ChoiceDialog("Launch proposal", message, [("later", "Decide later"), ("reject", "Turn it down"), ("approve", "Approve")], cancel="later"), decided)

    def selected_app(self) -> str | None:
        current = self.query_one("#apps", Menu).current
        return current.key.partition(":")[2] if current and current.key.startswith("app:") else None

    def action_add(self) -> None:
        self.app.open(AppEditScreen(None))

    def action_change(self) -> None:
        app_id = self.selected_app()
        if app_id:
            self.app.open(AppEditScreen(catalogue.get(app_id)))

    def action_remove(self) -> None:
        app_id = self.selected_app()
        if not app_id:
            return

        def decided(choice: str | None) -> None:
            if choice == "yes":
                if self.app.session.supervisor:
                    self.app.session.supervisor.stop(app_id)
                catalogue.remove(app_id)
                self.rebuild()

        self.app.open(confirm("Remove application", f"Remove {app_id} from this launcher?", "Remove"), decided)


class AppEditScreen(Page):
    KEYS = [Key("Tab", "Next field", "Next", essential=True), Key("Ctrl+S", "Save", "Save", essential=True), Key("Esc", "Cancel", "Back", essential=True)]
    BINDINGS = Page.BINDINGS + [Binding("ctrl+s", "save", "Save", show=False, priority=True)]

    def __init__(self, app: catalogue.App | None) -> None:
        super().__init__()
        self.existing = app
        self.TITLE_TEXT = f"Change {app.title}" if app else "Add an application"

    def compose_body(self) -> ComposeResult:
        app = self.existing or catalogue.App(id="")
        with VerticalScroll(classes="body"):
            with Vertical(classes="card") as card:
                card.border_title = "What it is"
                yield FieldRow("ID", Input(app.id, placeholder="org.example.planner", id="app-id", disabled=bool(self.existing)), id="row-id")
                yield FieldRow("Name", Input(app.name, placeholder="Route planner", id="app-name"), id="row-name")
            with Vertical(classes="card") as card:
                card.border_title = "How to start it"
                yield FieldRow("Commands", TextArea("\n".join(app.commands), id="app-commands", show_line_numbers=False, soft_wrap=True), id="row-commands")
                yield Static("One per line. All but the last must finish; the last stays running. {url}, {port}, {id} and {root} are filled in.", classes="hint field-hint")
                yield FieldRow("Runs in", Input(app.cwd, id="app-cwd"), id="row-cwd")
            with Vertical(classes="card") as card:
                card.border_title = "How it behaves"
                yield FieldRow("Ready when", Input(app.ready, id="app-ready"), id="row-ready")
                yield Static("fabric: it says so. process: it stays up. delay:5: after five seconds. Or a URL that answers.", classes="hint field-hint")
                yield FieldRow("Wait up to", Input(f"{app.timeout_s:g}", id="app-timeout"), "s", id="row-timeout")
                yield FieldRow("If it stops", Select([("Leave it stopped", "never"), ("Restart it", "on-failure")], allow_blank=False, value=app.restart, id="app-restart"), id="row-restart")
                yield FieldRow("Start with runs", Switch(value=app.autostart, id="app-autostart"), id="row-autostart")
                yield FieldRow("Required", Switch(value=app.required, id="app-required"), id="row-required")
            yield Static("", id="form-error", classes="error-text")
            yield Menu([MenuItem("save", "Save"), MenuItem("cancel", "Cancel")], id="actions")

    def on_mount(self) -> None:
        (self.query_one("#app-name", Input) if self.existing else self.query_one("#app-id", Input)).focus()

    def on_menu_selected(self, event: Menu.Selected) -> None:
        if event.item.key == "save":
            self.action_save()
        else:
            self.app.pop_screen()

    def action_save(self) -> None:
        for row in self.query(FieldRow):
            row.set_problem("")
        previous = self.existing or catalogue.App(id="")
        try:
            timeout = float(self.query_one("#app-timeout", Input).value or 0)
        except ValueError:
            self.query_one("#row-timeout", FieldRow).set_problem("Enter a number of seconds.")
            return
        app = catalogue.App(
            id=self.query_one("#app-id", Input).value.strip(),
            name=self.query_one("#app-name", Input).value.strip(),
            commands=[line.strip() for line in self.query_one("#app-commands", TextArea).text.splitlines() if line.strip()],
            cwd=self.query_one("#app-cwd", Input).value.strip() or ".",
            ready=self.query_one("#app-ready", Input).value.strip() or "fabric",
            timeout_s=timeout,
            restart=str(self.query_one("#app-restart", Select).value),
            autostart=self.query_one("#app-autostart", Switch).value,
            required=self.query_one("#app-required", Switch).value,
            env=previous.env, grants=previous.grants, settings=previous.settings,
        )
        try:
            if not self.existing and app.id in catalogue.load():
                raise ConfigurationError(f"{app.id} already exists.")
            catalogue.put(app)
        except ConfigurationError as exc:
            message = str(exc)
            target = ("row-commands" if "command" in message else "row-ready" if "ready" in message else "row-timeout" if "timeout" in message
                      else "row-restart" if "restart" in message else "row-id" if "ID" in message or "exists" in message else None)
            if target:
                self.query_one(f"#{target}", FieldRow).set_problem(message)
            else:
                self.query_one("#form-error", Static).update(message)
            return
        self.app.pop_screen()
