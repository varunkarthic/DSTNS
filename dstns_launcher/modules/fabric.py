# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""``./launcher fabric``: looking at and acting on a running server through the Fabric API."""
from __future__ import annotations

import argparse
import json

from ..core import fabric, server
from ..core.environment import State
from ..core.errors import DSTNSLauncherError
from ..core.reporting import Level
from . import Command, Context, Module

EXIT_OK = 0
EXIT_FAILURE = 1


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="./launcher fabric")
    actions = root.add_subparsers(dest="action")
    actions.add_parser("status", help="What is protecting what, and whether the audit log verifies")
    actions.add_parser("capabilities", help="What this server offers applications, as JSON")
    grant = actions.add_parser("grant", help="Give an application these permissions, and only these")
    grant.add_argument("id")
    grant.add_argument("capabilities", nargs="*")
    settings = actions.add_parser("settings", help="Read an application's settings, or change them")
    settings.add_argument("id")
    settings.add_argument("values", nargs="*", metavar="KEY=VALUE")
    audit = actions.add_parser("audit", help="What applications have done to the simulation")
    audit.add_argument("-n", type=int, default=20)
    return root


def _port() -> int:
    port = server.active_port()
    if port is None:
        raise DSTNSLauncherError("No server is running.", remedy="Start one with ./launcher start, then try again.")
    return port


def run(context: Context) -> int:
    options = parser().parse_args(context.arguments)
    action = options.action or "status"
    out = context.out
    port = _port()
    if action == "status":
        posture = fabric.security(port)
        if not posture:
            raise DSTNSLauncherError("The server did not answer as the operator.", remedy="Its credential is in the logs directory, as operator.token.")
        audit = posture["audit"]["verification"]
        intact = audit["intact"]
        out.heading("Fabric")
        out.status(State.PASS if posture["transport"]["tls"] else State.SKIPPED, "Connection", "Encrypted with TLS" if posture["transport"]["tls"] else "Plain HTTP, on this machine")
        out.status(State.FAIL if posture["store"]["rejected"] else State.PASS, "Credentials", "A changed store was rejected" if posture["store"]["rejected"] else "Tokens hashed, store sealed")
        out.status(State.PASS if intact else State.FAIL, "Audit log", f"Intact, {audit['checked']} entries checked" if intact else f"Altered at entry {audit.get('first_bad_sequence')}")
        out.status(State.PASS, "Applications", f"{posture['applications']['registered']} registered, {posture['applications']['requiring_signatures']} require signed requests")
        return EXIT_OK if intact and not posture["store"]["rejected"] else EXIT_FAILURE
    if action == "capabilities":
        print(json.dumps(fabric.capabilities(port), indent=2))
        return EXIT_OK
    if action == "grant":
        response = fabric.grant(port, options.id, options.capabilities)
        if not response.ok:
            raise DSTNSLauncherError(response.error_message())
        out.message(Level.SUCCESS, f"{options.id} now has", ", ".join(options.capabilities) or "nothing it had to ask for")
        return EXIT_OK
    if action == "settings":
        if options.values:
            values = {}
            for item in options.values:
                key, _, value = item.partition("=")
                try:
                    values[key] = json.loads(value)
                except ValueError:
                    values[key] = value
            response = fabric.update_settings(port, options.id, values)
            if not response.ok:
                raise DSTNSLauncherError(response.error_message())
        current = fabric.settings(port, options.id)
        if current is None:
            raise DSTNSLauncherError(f"The server does not know {options.id}.")
        out.pairs(list(current.get("values", {}).items()), width=20)
        return EXIT_OK
    if action == "audit":
        rows = [(entry["sequence"], entry["app_id"], entry["action"], entry["outcome"], entry["hash"][:12]) for entry in fabric.audit(port, options.n)]
        if rows:
            out.table(["#", "Application", "Action", "Outcome", "Hash"], rows, max_width=40)
        else:
            out.message(Level.INFO, "Applications have done nothing to the simulation")
        return EXIT_OK
    return EXIT_FAILURE


MODULE = Module(
    name="fabric",
    commands=(Command("fabric", "fabric [status|capabilities|grant|settings|audit]", "Look at and act on a running server through the Fabric API", run),),
)
