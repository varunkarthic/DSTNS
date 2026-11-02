# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The applications this launcher can start: what they are and how to start each.

``config/apps.json`` belongs to the person at this machine. What is in it runs, so nothing but
the launcher writes it: the Fabric API can only propose an entry, and a person approves it here.
"""
from __future__ import annotations

import json
import os
import re
import shlex
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .configuration import RunOptions
from .errors import ConfigurationError
from .paths import PATHS, Paths

_ID = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
_ENV = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_READY = re.compile(r"^(?:fabric|process|delay:\d+(?:\.\d+)?|https?://\S+)$")
RESTARTS = ("never", "on-failure")
MAX_COMMANDS = 8
MAX_COMMAND_BYTES = 1024
# What is given to an application, never taken from it.
RESERVED_ENV = {"DSTNS_OPERATOR_TOKEN", "DSTNS_URL", "DSTNS_PORT", "DSTNS_APP_ID"}


@dataclass
class App:
    id: str
    name: str = ""
    # Run in order. Each must finish successfully; the last is the application, and stays running.
    commands: list[str] = field(default_factory=list)
    cwd: str = "."
    env: dict[str, str] = field(default_factory=dict)
    # fabric: it reports itself active. process: it stays up. delay:S: a fixed wait. A URL: it answers.
    ready: str = "fabric"
    timeout_s: float = 60.0
    restart: str = "never"
    # A required application that fails stops the simulation from starting.
    required: bool = False
    autostart: bool = False
    # Permissions this person has already decided to give it, and the settings it should start with.
    grants: list[str] = field(default_factory=list)
    settings: dict[str, Any] = field(default_factory=dict)
    # A web interface of its own: the observer offers a button that opens it in a new tab.
    web_url: str = ""
    web_label: str = ""

    @property
    def title(self) -> str:
        return self.name or self.id


def validate(app: App) -> App:
    if not (3 <= len(app.id) <= 64) or not _ID.match(app.id):
        raise ConfigurationError(f'"{app.id}" is not an application ID.', remedy="Use 3 to 64 lower-case letters, digits, dots and hyphens, such as org.example.planner.")
    if not app.commands or len(app.commands) > MAX_COMMANDS:
        raise ConfigurationError(f"{app.id} needs 1 to {MAX_COMMANDS} commands.", remedy='Add one with --command "python3 app.py --url {url}".')
    for command in app.commands:
        if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_BYTES:
            raise ConfigurationError(f"{app.id} has a command that is empty or over {MAX_COMMAND_BYTES} bytes.")
        try:
            shlex.split(command)
        except ValueError as exc:
            raise ConfigurationError(f"{app.id} has a command that cannot be read: {exc}", remedy=command) from exc
    if not _READY.match(app.ready):
        raise ConfigurationError(f'"{app.ready}" is not a way of being ready.', remedy="Use fabric, process, delay:SECONDS or an http(s) URL.")
    if not 1 <= app.timeout_s <= 600:
        raise ConfigurationError(f"{app.id}: the timeout must be 1 to 600 seconds.")
    if app.restart not in RESTARTS:
        raise ConfigurationError(f'"{app.restart}" is not a restart policy.', remedy="Use never or on-failure.")
    if app.web_url and (not re.match(r"^https?://\S+$", app.web_url) or len(app.web_url) > 2000):
        raise ConfigurationError(f"{app.id}: the web address must be an http or https URL.", remedy="For example http://127.0.0.1:5173/")
    if len(app.web_label) > 40:
        raise ConfigurationError(f"{app.id}: the web button's label is at most 40 characters.")
    for name in app.env:
        if not _ENV.match(name) or name in RESERVED_ENV:
            raise ConfigurationError(f"{name} cannot be set for an application.", remedy=f"{', '.join(sorted(RESERVED_ENV))} are the launcher's." if name in RESERVED_ENV else "")
    return app


def _from_record(app_id: str, record: dict[str, Any]) -> App:
    known = App.__dataclass_fields__
    return validate(App(**{**{key: value for key, value in record.items() if key in known}, "id": app_id}))


def catalogue_path(paths: Paths = PATHS) -> Path:
    return Path(os.environ.get("DSTNS_APPS_FILE") or paths.root / "config" / "apps.json")


def load(paths: Paths = PATHS) -> dict[str, App]:
    path = catalogue_path(paths)
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise ConfigurationError(f"{path} is not valid JSON (line {exc.lineno}).", remedy="Correct the file, or remove it to start again.") from exc
    return {app_id: _from_record(app_id, record) for app_id, record in (saved.get("apps") or {}).items()}


def save(catalogue: dict[str, App], paths: Paths = PATHS) -> None:
    path = catalogue_path(paths)
    path.parent.mkdir(parents=True, exist_ok=True)
    records = {app_id: {key: value for key, value in asdict(app).items() if key != "id"} for app_id, app in sorted(catalogue.items())}
    temporary = path.with_suffix(".tmp")
    # Written beside the target and renamed, so that a crash leaves the old file whole.
    temporary.write_text(json.dumps({"version": 1, "apps": records}, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def put(app: App, paths: Paths = PATHS) -> App:
    validate(app)
    catalogue = load(paths)
    catalogue[app.id] = app
    save(catalogue, paths)
    return app


def remove(app_id: str, paths: Paths = PATHS) -> None:
    catalogue = load(paths)
    if app_id not in catalogue:
        raise ConfigurationError(f"No application {app_id}.", remedy="./launcher apps list shows them.")
    del catalogue[app_id]
    save(catalogue, paths)


def get(app_id: str, paths: Paths = PATHS) -> App:
    catalogue = load(paths)
    if app_id not in catalogue:
        raise ConfigurationError(f"No application {app_id}.", remedy="./launcher apps list shows them.")
    return catalogue[app_id]


def selection(options: RunOptions, paths: Paths = PATHS) -> list[App]:
    """What this run should start: those named, or else those set to start by themselves."""
    if options.no_apps:
        return []
    catalogue = load(paths)
    if options.apps is None:
        return [app for app in catalogue.values() if app.autostart]
    names = [name.strip() for name in options.apps.split(",") if name.strip()]
    missing = [name for name in names if name not in catalogue]
    if missing:
        raise ConfigurationError(f"No application {', '.join(missing)}.", remedy="./launcher apps list shows them, and ./launcher apps add adds one.")
    return [catalogue[name] for name in names]


def problems(app: App, paths: Paths = PATHS) -> list[str]:
    """What will stop it from starting, found before trying."""
    import shutil

    found = []
    where = (paths.root / app.cwd).resolve()
    if not where.is_dir():
        found.append(f"The working directory {app.cwd} does not exist.")
    for command in app.commands:
        program = shlex.split(command)[0]
        if "/" in program:
            target = where / program
            if not target.exists():
                found.append(f"{program} does not exist in {app.cwd}.")
            elif not os.access(target, os.X_OK):
                found.append(f"{program} is not executable.")
        elif not shutil.which(program):
            found.append(f"{program} is not on this machine's PATH.")
    return found
