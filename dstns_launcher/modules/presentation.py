# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""``./launcher demo``: the start-up film on a loop, with every feature, full screen and with music."""
from __future__ import annotations

import argparse
import os
import signal
import threading

from ..core import api, configuration, server
from ..core.errors import DSTNSLauncherError
from ..core.reporting import Level
from . import Command, Context, Module, Page

EXIT_OK = 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="./launcher demo", description="The start-up film on a loop, with every feature, until Ctrl+C.")
    root.add_argument("--no-open", action="store_true", help="Don't open the observer; print its address")
    root.add_argument("--no-music", action="store_true", help="Without music, this time")
    root.add_argument("--no-fullscreen", action="store_true", help="In a window, this time")
    return root


def demo(context: Context) -> int:
    """A server of its own, with no simulation, and the observer showing its film until Ctrl+C."""
    options = parser().parse_args(context.arguments)
    out = context.out
    config = configuration.load()
    for flag, key in ((options.no_music, "demo.music"), (options.no_fullscreen, "demo.fullscreen")):
        if flag:
            config.setdefault("demo", {})[key.split(".")[1]] = False
    shown = configuration.presentation(config, demo=True)
    # A server of its own, so that one already running for real work is left alone.
    if server.active_port() is not None:
        os.environ["DSTNS_API_PORT"] = str(api.free_port(configuration.load()["api"]["port"] + 10))
    handle = server.start(context.reporter, demo=True, config=config)
    if not handle.managed:
        raise DSTNSLauncherError("A Demo Mode server is already running.", remedy=f"It's at {handle.url}.")
    finished = threading.Event()
    previous = signal.signal(signal.SIGTERM, lambda *_: finished.set())
    try:
        if not options.no_open:
            context.session.open_observer(handle.url + "/", demo=True, config=config)
        out.message(Level.SUCCESS, "Demo Mode", handle.url)
        out.muted(("Full screen, " if shown["fullscreen"] else "") + ("with music. " if shown["music"] else "without music. ")
                  + "Change these with ./launcher config. Press Ctrl+C to end it.")
        while not finished.wait(0.5):
            if handle.process is not None and handle.process.poll() is not None:
                raise DSTNSLauncherError("The Demo Mode server stopped.")
    except KeyboardInterrupt:
        out.write()
    finally:
        signal.signal(signal.SIGTERM, previous)
        server.shut_down(handle)
    out.message(Level.INFO, "Demo Mode ended")
    return EXIT_OK


def _describe(app) -> tuple[str, list, str]:
    from ..core.paths import PATHS
    from ..tui.widgets import Row

    config = configuration.load()
    here = len(list(PATHS.fastboot.glob("*.osm.xml.gz"))) if PATHS.fastboot.exists() else 0
    rows = [Row("Fast Boot", "on" if configuration.setting(config, "startup.fast_boot") else "off", None),
            Row("Cities downloaded", str(here), None),
            Row("Demo music", "on" if configuration.setting(config, "demo.music") else "off", None)]
    return "Demo and Fast Boot", rows, "Enter shows them: play Demo Mode, or download every city for Fast Boot."


def _opens_page():
    from ..tui.screens.tasks import PresentationScreen

    return PresentationScreen()


MODULE = Module(
    name="presentation",
    commands=(Command("demo", "demo", "The start-up film on a loop with every feature, full screen and with music", demo),),
    pages=(Page("presentation", "Demo and Fast Boot", _opens_page, _describe, before="diagnostics"),),
)
