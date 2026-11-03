# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""``./launcher fastboot``: every city's map, downloaded in advance and kept compressed.

With Fast Boot on, the server unpacks the city a seed chooses from here, which takes a moment and needs no network,
instead of downloading it, which can take a minute. Downloading all of them takes a long while, since each comes
from a volunteer-run Overpass server, one at a time and with a pause between, as their usage policy asks. It can be
stopped at any point and carries on from where it got to. A city already in the map cache is compressed from there.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from ..core import configuration, server
from ..core.errors import ConfigurationError, DSTNSLauncherError
from ..core.paths import PATHS, Paths
from ..core.reporting import Level
from . import Command, Context, Module

EXIT_OK = 0
EXIT_FAILURE = 1
PAUSE_S = 2.0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="./launcher fastboot", description=__doc__.split("\n\n")[0])
    actions = root.add_subparsers(dest="action")
    download = actions.add_parser("download", help="Download every city not yet here. Stop with Ctrl+C, and carry on later")
    download.add_argument("--cities", help="Only these, comma separated, by name or key (london, london_x5000)")
    download.add_argument("--limit", type=int, help="At most this many this time")
    actions.add_parser("status", help="How many cities are here, and how much room they take")
    clear = actions.add_parser("clear", help="Delete them all")
    clear.add_argument("--yes", "-y", action="store_true")
    return root


def cities(paths: Paths = PATHS) -> list[dict]:
    """Every city a seed can choose, as the server knows them, for the extent the configuration uses."""
    extent = (configuration.load(paths).get("map") or {}).get("city_extent_m", 5000)
    try:
        done = subprocess.run([str(paths.server), "--list-cities", str(extent)], capture_output=True, text=True, timeout=30, check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise DSTNSLauncherError("The server could not list its cities.", remedy="Build it first: ./launcher start builds it.") from exc
    return json.loads(done.stdout)


def packed(paths: Paths, key: str) -> Path:
    return paths.fastboot / f"{key}.osm.xml.gz"


def pack(source: Path, target: Path) -> None:
    """Compressed beside the target and renamed, so that what is there is always whole."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".gz.tmp")
    with open(source, "rb") as reading, gzip.open(temporary, "wb", compresslevel=9) as writing:
        shutil.copyfileobj(reading, writing, 1 << 20)
    os.replace(temporary, target)


def _download(context: Context, options: argparse.Namespace, paths: Paths) -> int:
    out = context.out
    everything = cities(paths)
    wanted = {name.strip().lower() for name in options.cities.split(",")} if options.cities else None
    chosen = [c for c in everything if wanted is None or c["city"].lower() in wanted or c["key"] in wanted]
    if wanted and not chosen:
        raise ConfigurationError(f"None of {options.cities} is a city a seed can choose.", remedy="./launcher fastboot status lists them.")
    missing = [c for c in chosen if not packed(paths, c["key"]).exists()]
    out.message(Level.INFO, f"{len(chosen) - len(missing)} of {len(chosen)} cities are here", f"{len(missing)} to get")
    if options.limit is not None:
        missing = missing[: max(0, options.limit)]
    cache = server._maps(paths)
    failed: list[str] = []
    for number, city in enumerate(missing, 1):
        target = packed(paths, city["key"])
        cached = cache / f"{city['key']}.osm.xml"
        label = f"{number} of {len(missing)}: {city['city']}, {city['country']}"
        if cached.exists() and cached.stat().st_size > 4096:
            pack(cached, target)
            out.message(Level.SUCCESS, label, "from the map cache")
            continue
        temporary = paths.fastboot / f"{city['key']}.osm.xml.download"
        temporary.parent.mkdir(parents=True, exist_ok=True)
        command = [str(paths.server), "--fetch-osm", f"--bbox={city['bbox']}", "--output", str(temporary)]
        out.message(Level.INFO, label, "downloading")
        try:
            done = subprocess.run(command, cwd=paths.root, capture_output=True, text=True, timeout=900)
        except subprocess.TimeoutExpired:
            done = None
        if done is None or done.returncode != 0 or not temporary.exists():
            failed.append(city["city"])
            reason = (done.stderr.strip().splitlines() or ["no reason given"])[-1] if done else "it took over 15 minutes"
            out.message(Level.WARNING, f"{city['city']} did not download", reason)
        else:
            pack(temporary, target)
            out.message(Level.SUCCESS, label, f"{target.stat().st_size / 1e6:.1f} MB compressed")
        temporary.unlink(missing_ok=True)
        for extra in (Path(str(temporary) + ".progress"),):
            extra.unlink(missing_ok=True)
        if number < len(missing):
            time.sleep(PAUSE_S)
    if failed:
        out.message(Level.WARNING, f"{len(failed)} did not download", ", ".join(failed) + ". Run this again to try them again.")
        return EXIT_FAILURE
    out.message(Level.SUCCESS, "Fast Boot has its cities", "Turn it on with ./launcher config, under Startup.")
    return EXIT_OK


def _status(context: Context, paths: Paths) -> int:
    out = context.out
    everything = cities(paths)
    here = [c for c in everything if packed(paths, c["key"]).exists()]
    size = sum(packed(paths, c["key"]).stat().st_size for c in here)
    on = configuration.setting(configuration.load(paths), "startup.fast_boot")
    out.pairs([("Cities here", f"{len(here)} of {len(everything)}"), ("Room taken", f"{size / 1e6:.0f} MB"), ("Kept in", str(paths.fastboot)),
               ("Fast Boot", "on" if on else "off (./launcher config, under Startup)")], width=14)
    missing = [c["city"] for c in everything if c not in here]
    if missing and len(missing) <= 20:
        out.muted("Still to get: " + ", ".join(missing))
    return EXIT_OK


def run(context: Context) -> int:
    options = parser().parse_args(context.arguments)
    paths = PATHS
    if options.action == "download":
        try:
            return _download(context, options, paths)
        except KeyboardInterrupt:
            context.out.write()
            context.out.message(Level.INFO, "Stopped", "Run it again to carry on from here.")
            return EXIT_OK
    if options.action == "clear":
        if not options.yes and not (context.caps.interactive and context.out.confirm(f"Delete every city in {paths.fastboot}?", default=False)):
            context.out.message(Level.INFO, "Nothing deleted")
            return EXIT_OK
        shutil.rmtree(paths.fastboot, ignore_errors=True)
        context.out.message(Level.SUCCESS, "Deleted")
        return EXIT_OK
    return _status(context, paths)


MODULE = Module(
    name="fastboot",
    commands=(Command("fastboot", "fastboot [download|status|clear]", "Every city's map in advance, so that Fast Boot starts in seconds", run),),
)
