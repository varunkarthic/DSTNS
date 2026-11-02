# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""``./launcher apps``: the applications this launcher can start."""
from __future__ import annotations

import argparse
import json
import signal
import threading
import time

from ..core import apps as catalogue
from ..core import fabric, server
from ..core.errors import ConfigurationError, DSTNSLauncherError
from ..core.reporting import Level
from ..core.supervisor import Phase, Supervisor, tail
from . import Command, Context, Module, Page

EXIT_OK = 0
EXIT_FAILURE = 1


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="./launcher apps", add_help=True)
    actions = root.add_subparsers(dest="action")

    def spec(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("--command", action="append", metavar="CMD", help="A command to run. Repeat for several: all but the last must finish, and the last stays running. {url}, {port}, {id} and {root} are filled in.")
        sub.add_argument("--name", help="What to call it")
        sub.add_argument("--cwd", help="Where to run it, relative to this checkout")
        sub.add_argument("--env", action="append", metavar="KEY=VALUE", default=[], help="An environment variable")
        sub.add_argument("--ready", help="How to tell it is ready: fabric (default), process, delay:SECONDS, or a URL")
        sub.add_argument("--timeout", type=float, help="Seconds to wait until it is ready")
        sub.add_argument("--restart", choices=catalogue.RESTARTS, help="What to do if it stops")
        sub.add_argument("--required", action=argparse.BooleanOptionalAction, default=None, help="Stop the simulation from starting if this fails")
        sub.add_argument("--autostart", action=argparse.BooleanOptionalAction, default=None, help="Start with every simulation unless told otherwise")
        sub.add_argument("--grant", action="append", metavar="CAPABILITY", default=[], help="A permission to give it when it registers")
        sub.add_argument("--setting", action="append", metavar="KEY=VALUE", default=[], help="A setting to give it when it registers. The value is read as JSON if it can be")

    lister = actions.add_parser("list", help="Show them all")
    lister.add_argument("--json", action="store_true")
    spec(actions.add_parser("add", help="Add one"))
    actions.choices["add"].add_argument("id")
    spec(actions.add_parser("set", help="Change one: only what is given"))
    actions.choices["set"].add_argument("id")
    shower = actions.add_parser("show", help="Show one")
    shower.add_argument("id")
    shower.add_argument("--json", action="store_true")
    actions.add_parser("remove", help="Remove one").add_argument("id")
    runner = actions.add_parser("run", help="Start these and look after them until Ctrl+C. Needs a running server")
    runner.add_argument("ids", nargs="+", metavar="ID")
    actions.add_parser("status", help="What the server knows of each")
    logs = actions.add_parser("logs", help="An application's output")
    logs.add_argument("id")
    logs.add_argument("-n", type=int, default=40)
    doctor = actions.add_parser("doctor", help="Find what would stop them from starting")
    doctor.add_argument("id", nargs="?")
    actions.add_parser("proposals", help="Launch entries proposed through the Fabric API")
    approve = actions.add_parser("approve", help="Accept a proposal, after reading exactly what it runs")
    approve.add_argument("id")
    approve.add_argument("--yes", "-y", action="store_true")
    actions.add_parser("reject", help="Turn a proposal down").add_argument("id")
    return root


def _pairs(values: list[str], what: str) -> dict[str, str]:
    out = {}
    for value in values:
        if "=" not in value:
            raise ConfigurationError(f'"{value}" is not {what}.', remedy="Write it as KEY=VALUE.")
        key, _, item = value.partition("=")
        out[key] = item
    return out


def _value(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return text


def _apply(app: catalogue.App, options: argparse.Namespace) -> catalogue.App:
    for field, value in (("commands", options.command), ("name", options.name), ("cwd", options.cwd), ("ready", options.ready),
                         ("timeout_s", options.timeout), ("restart", options.restart), ("required", options.required), ("autostart", options.autostart)):
        if value is not None:
            setattr(app, field, value)
    app.env.update(_pairs(options.env, "an environment variable"))
    app.grants = sorted(set(app.grants) | set(options.grant))
    app.settings.update({key: _value(item) for key, item in _pairs(options.setting, "a setting").items()})
    return app


def _summary(app: catalogue.App) -> list[tuple[str, object]]:
    return [
        ("ID", app.id), ("Name", app.title),
        *[(f"Command {n + 1}" if len(app.commands) > 1 else "Command", command) for n, command in enumerate(app.commands)],
        ("Runs in", app.cwd), ("Ready when", _ready_words(app)), ("Waits up to", f"{app.timeout_s:.0f} s"),
        ("If it stops", "Restart it" if app.restart == "on-failure" else "Leave it stopped"),
        ("Required", "Yes: the simulation will not start without it" if app.required else "No"),
        ("Starts with runs", "Yes" if app.autostart else "Only when chosen"),
        *([("Environment", ", ".join(f"{k}={v}" for k, v in app.env.items()))] if app.env else []),
        *([("Permissions", ", ".join(app.grants))] if app.grants else []),
        *([("Settings", json.dumps(app.settings))] if app.settings else []),
    ]


def _ready_words(app: catalogue.App) -> str:
    if app.ready == "fabric":
        return "It reports itself active through Fabric"
    if app.ready == "process":
        return "It stays up for a second"
    if app.ready.startswith("delay:"):
        return f"{app.ready[6:]} s have passed"
    return f"{app.ready} answers"


def _port() -> int:
    port = server.active_port()
    if port is None:
        raise DSTNSLauncherError("No server is running.", remedy="Start one with ./launcher start, then try again.")
    return port


def run(context: Context) -> int:
    options = parser().parse_args(context.arguments)
    action = options.action or "list"
    out = context.out
    if action == "list":
        apps = catalogue.load()
        if getattr(options, "json", False):
            print(json.dumps({app_id: vars(app) for app_id, app in apps.items()}, indent=2))
            return EXIT_OK
        if not apps:
            out.message(Level.INFO, "No applications yet")
            out.muted('Add one with ./launcher apps add org.example.app --command "python3 app.py --url {url}"')
            return EXIT_OK
        out.table(["ID", "Name", "Starts", "Required", "Command"], [(a.id, a.title, "with runs" if a.autostart else "when chosen", "yes" if a.required else "no", a.commands[-1]) for a in apps.values()], max_width=60)
        return EXIT_OK
    if action in {"add", "set"}:
        if action == "add":
            if options.id in catalogue.load():
                raise ConfigurationError(f"{options.id} already exists.", remedy=f"Change it with ./launcher apps set {options.id}.")
            app = _apply(catalogue.App(id=options.id), options)
        else:
            app = _apply(catalogue.get(options.id), options)
        catalogue.put(app)
        out.message(Level.SUCCESS, f"{'Added' if action == 'add' else 'Changed'} {app.title}")
        out.pairs(_summary(app), width=18)
        for problem in catalogue.problems(app):
            out.message(Level.WARNING, problem)
        return EXIT_OK
    if action == "show":
        app = catalogue.get(options.id)
        if options.json:
            print(json.dumps(vars(app), indent=2))
        else:
            out.pairs(_summary(app), width=18)
        return EXIT_OK
    if action == "remove":
        catalogue.remove(options.id)
        out.message(Level.SUCCESS, f"Removed {options.id}")
        return EXIT_OK
    if action == "doctor":
        apps = [catalogue.get(options.id)] if options.id else list(catalogue.load().values())
        worst = EXIT_OK
        for app in apps:
            found = catalogue.problems(app)
            if found:
                worst = EXIT_FAILURE
                out.message(Level.ERROR, app.title, found[0])
                for problem in found[1:]:
                    out.muted("  " + problem)
            else:
                out.message(Level.SUCCESS, app.title, "nothing in the way")
        return worst
    if action == "logs":
        app = catalogue.get(options.id)
        path = server_logs() / f"{app.id}.log"
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[-options.n:]:
                out.line(line)
        except OSError:
            out.message(Level.INFO, "No output yet", str(path))
        return EXIT_OK
    if action == "status":
        return _status(context)
    if action == "run":
        return _run(context, options.ids)
    if action == "proposals":
        items = fabric.proposals(_port())
        if not items:
            out.message(Level.INFO, "No proposals are waiting")
            return EXIT_OK
        for item in items:
            out.heading(item["id"])
            out.muted(f"Proposed by the {item.get('proposed_by', 'unknown')}. Nothing runs until you approve it.")
            for command in item["spec"]["commands"]:
                out.line("  " + command)
        return EXIT_OK
    if action == "approve":
        return _approve(context, options)
    if action == "reject":
        response = fabric.withdraw(_port(), options.id)
        if not response.ok:
            raise DSTNSLauncherError(response.error_message())
        out.message(Level.SUCCESS, f"Turned down {options.id}")
        return EXIT_OK
    raise ConfigurationError(f"Unknown action {action}.")


def server_logs():
    from ..core.paths import PATHS

    return PATHS.logs / "apps"


def _status(context: Context) -> int:
    out = context.out
    port = _port()
    known = {app["id"]: app for app in fabric.apps(port)}
    rows = []
    for app_id, app in sorted({**{a: None for a in catalogue.load()}, **known}.items()):
        health = fabric.health(port, app_id) if app else None
        pending = (app or {}).get("capabilities", {}).get("pending", [])
        rows.append((app_id, (app or {}).get("state", "not connected"), f"{health['requests']}" if health else "", f"{health['refused']}" if health else "", ", ".join(pending)))
    if rows:
        out.table(["ID", "State", "Requests", "Refused", "Waiting for permission"], rows, max_width=60)
    else:
        out.message(Level.INFO, "No applications are connected")
    return EXIT_OK


def _run(context: Context, ids: list[str]) -> int:
    out = context.out
    apps = [catalogue.get(app_id) for app_id in ids]
    supervisor = Supervisor(_port(), context.reporter)
    finished = threading.Event()
    previous = signal.signal(signal.SIGTERM, lambda *_: finished.set())
    try:
        for app in apps:
            supervisor.start(app)
        out.message(Level.INFO, "Starting", ", ".join(app.title for app in apps))
        out.muted("Press Ctrl+C to stop them.")
        while not finished.wait(0.5):
            states = supervisor.states()
            if all(running.phase in (Phase.FAILED, Phase.STOPPED) for running in states):
                for running in states:
                    if running.phase is Phase.FAILED:
                        out.message(Level.ERROR, f"{running.app.title} did not stay up", running.detail or tail(running.log))
                return EXIT_FAILURE if any(running.phase is Phase.FAILED for running in states) else EXIT_OK
    except KeyboardInterrupt:
        out.write()
    finally:
        signal.signal(signal.SIGTERM, previous)
        supervisor.stop_all()
        time.sleep(0.2)
    out.message(Level.INFO, "Stopped")
    return EXIT_OK


def _approve(context: Context, options: argparse.Namespace) -> int:
    out = context.out
    port = _port()
    proposal = next((item for item in fabric.proposals(port) if item["id"] == options.id), None)
    if proposal is None:
        raise ConfigurationError(f"No proposal for {options.id}.", remedy="./launcher apps proposals shows those waiting.")
    spec = proposal["spec"]
    app = catalogue.App(id=options.id, name=str(spec.get("name", "")), commands=list(spec["commands"]), cwd=str(spec.get("cwd", ".")), env=dict(spec.get("env") or {}),
                        ready=str(spec.get("ready", "fabric")), timeout_s=float(spec.get("timeout_s", 60)), restart=str(spec.get("restart", "never")))
    catalogue.validate(app)
    out.heading(f"Proposed by the {proposal.get('proposed_by', 'unknown')}")
    out.pairs(_summary(app), width=18)
    out.write()
    out.message(Level.WARNING, "These commands will run on this machine, as you")
    if not options.yes and not (context.caps.interactive and out.confirm("Approve?", default=False)):
        out.message(Level.INFO, "Not approved")
        return EXIT_OK
    catalogue.put(app)
    fabric.withdraw(port, options.id)
    out.message(Level.SUCCESS, f"Approved {app.title}")
    return EXIT_OK


def _opens_page():
    from ..tui.screens.apps import AppsScreen

    return AppsScreen()


def _describe(app) -> tuple[str, list, str]:
    from ..core.environment import State
    from ..tui.widgets import Row

    try:
        entries = catalogue.load()
    except DSTNSLauncherError as exc:
        return "Applications", [Row("Catalogue", str(exc), State.FAIL)], ""
    rows = [Row(entry.title, "with every run" if entry.autostart else "when chosen", None) for entry in list(entries.values())[:6]]
    return "Applications", rows, ("Enter shows them, to add, run or change one." if entries else "None yet. Enter adds one: a command or two that start your program alongside the simulation.")


MODULE = Module(
    name="apps",
    commands=(Command("apps", "apps [list|add|set|show|remove|run|status|logs|doctor|proposals|approve|reject]", "The applications this launcher can start alongside a simulation", run),),
    pages=(Page("apps", "Applications", _opens_page, _describe),),
)
