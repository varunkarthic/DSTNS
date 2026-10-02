# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Command line: arguments, scripted commands, and choosing an interface.

Scripted commands (``start`` without a terminal, ``test``, ``seeds``…) print
plain lines and return an exit status, exactly as they always have. Interactive
use opens the Textual interface, and falls back to compatibility mode, then to
plain text, if that cannot start.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import traceback
from dataclasses import dataclass, field

from .core import configuration, logsetup, maintenance, server, simulation, sumo, testing
from .core import seeds as seed_store
from .core.configuration import RunOptions
from .core.errors import ConfigurationError, DSTNSLauncherError
from .core.paths import PATHS
from .core.reporting import Level
from .core.session import Session
from .core.terminal import Capabilities, detect
from .core.version import (COPYRIGHT_ASCII, LICENSE_SPDX, OSM_ATTRIBUTION, OSM_LICENSE, PRODUCT, engine_version)
from .fallback.formatting import LineReporter, Output, make_output

LOG = logging.getLogger("dstns.launcher")

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_INTERRUPTED = 130
EXIT_TERMINATED = 143

VALUE_OPTIONS = {"--seed", "--saved-seed", "--save-seed", "--day-type", "--osm-file", "--max-nodes", "--duration",
                 "--speed", "--description"}
# Options that take a value but are not part of a run request.
SETTING_OPTIONS = {"--compute", "--gpu-device", "--profile"}
COMMANDS = {"start", "console", "seeds", "ui", "logs", "config", "test", "sumo", "reset", "help", "version", "license",
            "diagnostics", "bootstrap"}


@dataclass
class Arguments:
    command: str | None = None
    topic: str | None = None
    item: str | None = None
    run: RunOptions = field(default_factory=RunOptions)
    mode: str | None = None
    yes: bool = False
    verbose: bool = False
    open: bool = field(default_factory=simulation.can_open_browser)
    no_splash: bool = False
    no_animation: bool = False
    debug: bool = False
    reduced_ui: bool = False
    no_tui: bool = False
    no_color: bool = False
    compute: str | None = None
    gpu_device: str | None = None
    profile: str | None = None
    check: bool = False
    refresh: bool = False


def parse(argv: list[str]) -> Arguments:
    args = Arguments()
    positional: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in {"--yes", "-y"}:
            args.yes = True
        elif arg in {"--verbose", "-v"}:
            args.verbose = True
        elif arg in {"--open", "-o"}:
            args.open = True
        elif arg == "--no-open":
            args.open = False
        elif arg in {"--help", "-h"}:
            positional.append("help")
        elif arg in {"--version", "-V"}:
            positional.append("version")
        elif arg in {"--license", "--licence"}:
            positional.append("license")
        elif arg == "--no-splash":
            args.no_splash = True
        elif arg == "--no-animation":
            args.no_animation = True
        elif arg == "--debug":
            args.debug = True
        elif arg == "--reduced-ui":
            args.reduced_ui = True
        elif arg == "--no-tui":
            args.no_tui = True
        elif arg == "--no-color":
            args.no_color = True
        elif arg.startswith("--mode="):
            args.mode = arg.split("=", 1)[1]
        elif arg == "--mode" and index + 1 < len(argv):
            index += 1
            args.mode = argv[index]
        elif arg == "--check":
            args.check = True
        elif arg == "--refresh":
            args.refresh = True
        elif arg in SETTING_OPTIONS:
            if index + 1 >= len(argv) or argv[index + 1].startswith("--"):
                raise ConfigurationError(f"Missing value for {arg}")
            index += 1
            setattr(args, arg[2:].replace("-", "_"), argv[index])
        elif arg in VALUE_OPTIONS:
            if index + 1 >= len(argv) or argv[index + 1].startswith("--"):
                raise ConfigurationError(f"Missing value for {arg}")
            index += 1
            setattr(args.run, arg[2:].replace("-", "_"), argv[index])
        elif arg.startswith("-"):
            raise ConfigurationError(f"Unknown option: {arg}", remedy="./launcher help lists every option.")
        else:
            positional.append(arg)
        index += 1
    args.command = positional[0] if positional else None
    args.topic = positional[1] if len(positional) > 1 else None
    args.item = positional[2] if len(positional) > 2 else None
    if args.run.day_type and args.run.day_type not in {"weekday", "weekend"}:
        raise ConfigurationError("--day-type must be weekday or weekend")
    if args.compute is not None and args.compute not in {"auto", "cpu", "vulkan"}:
        raise ConfigurationError("--compute must be auto, cpu or vulkan")
    if args.gpu_device is not None and (not args.gpu_device.strip() or len(args.gpu_device) > 256):
        raise ConfigurationError("--gpu-device must be auto, a device index, a UUID or part of a device name")
    if args.profile is not None and args.profile not in {"minimal", "standard", "full"}:
        raise ConfigurationError("--profile must be minimal, standard or full")
    return args


HELP = f"""\
{PRODUCT} launcher

Usage: ./launcher [command] [options]

Commands
  (none)                 Open the launcher; without a terminal, start a run
  start                  Build what changed, start or reuse the server, start a run
  console                Open the launcher dashboard
  seeds save|list|inspect|delete [ID]
                         Manage saved seeds (prints JSON)
  ui open|dev|build|install
                         Open the observer, run its dev server, build or install it
  logs [system|api|event|playback]
                         Show the server's logs
  config                 Edit config/defaults.json
  test [all|unit|api|replay|benchmark|sumo|ui]
                         Run test stages
  sumo                   Check the SUMO toolchain on a synthetic grid
  diagnostics [gpu] [--refresh]
                         Check this machine; gpu tests every Vulkan device for real
  bootstrap [--check] [--yes] [--profile minimal|standard|full]
                         Install what DSTNS needs with the system package manager
                         (asks first; never installs GPU drivers)
  reset [--yes]          Delete runtime logs, checkpoints and temporary files
  help, version, license

Run options (start, seeds save)
  --seed N               Decimal or 0x hexadecimal, up to 128 bits
  --saved-seed ID        Run a saved configuration
  --save-seed ID         Save this configuration under ID
  --description TEXT     Note stored with --save-seed
  --day-type weekday|weekend
  --duration SECONDS     60 to 3600: wall-clock length of the day at 1x
  --speed X              0.01 to 5
  --max-nodes N          2 to 50000
  --osm-file PATH        Run this map instead of letting the seed choose
  --open, --no-open      Open the observer in a browser (default: when a desktop is present)

Compute options (start)
  --compute auto|cpu|vulkan
                         Where the physics runs; overrides compute.backend. Results
                         are identical on every backend
  --gpu-device auto|INDEX|UUID|NAME
                         Which GPU, when more than one is present

Interface options
  --reduced-ui           Use compatibility mode (Rich or plain text)
  --no-tui               Use plain line-oriented mode
  --no-color             Disable colour (NO_COLOR is also honoured)
  --no-splash            Skip the start-up screen
  --no-animation         Keep activity indicators static
  --debug                Verbose diagnostics and tracebacks
  --verbose, -v          Show command output while tests and builds run
  --yes, -y              Do not ask for confirmation (reset)
  --mode=server          Run the C++ server in the foreground

Documentation: https://dstns.readthedocs.io/guide/operator-cli/
"""


def licence_lines(unicode: bool = True) -> list[str]:
    copyright_text = "Copyright © 2026 Varun Karthic" if unicode else f"Copyright {COPYRIGHT_ASCII}"
    osm = OSM_ATTRIBUTION if unicode else "(C) OpenStreetMap contributors"
    return [
        copyright_text,
        f"Licence {LICENSE_SPDX}: this is free software, and you are welcome to",
        "redistribute it under certain conditions; see LICENSE.",
        "It comes with ABSOLUTELY NO WARRANTY.",
        f"Map data {osm}, available under the ODbL.",
    ]


# --- Scripted commands ---------------------------------------------------------


def command_seeds(args: Arguments, out: Output) -> int:
    if args.topic not in {"save", "list", "inspect", "delete"}:
        raise ConfigurationError("Usage: dstns seeds save|list|inspect|delete [ID]")
    data: dict = {"id": args.item, "description": args.run.description}
    if args.topic == "save":
        data["config"] = configuration.start_request(args.run)
        data["description"] = args.run.description or ""
    print(json.dumps(seed_store.operate(args.topic, data), indent=2))
    return EXIT_OK


def command_ui(args: Arguments, out: Output, reporter: LineReporter) -> int:
    from .core import build, process

    action = (args.topic or "open").lower()
    if action == "build":
        build.execute(build.plan(force_ui=True), reporter)
        reporter.message(Level.SUCCESS, "Observer bundle rebuilt")
    elif action == "dev":
        reporter.message(Level.INFO, "Starting the observer development server (Vite)")
        return os.spawnvp(os.P_WAIT, "npm", ["npm", "run", "dev", "--prefix", str(PATHS.ui_engine)])
    elif action == "install":
        process.run(["npm", "install", "--prefix", str(PATHS.ui_engine)], on_line=lambda line: reporter.step_output("npm", line))
        reporter.message(Level.SUCCESS, "Observer dependencies installed")
    elif action == "open":
        port = server.active_port()
        if port is None:
            raise DSTNSLauncherError("No current observer server is running. Use ./launcher start first.")
        url = f"http://127.0.0.1:{port}/"
        if simulation.open_in_browser(url):
            reporter.message(Level.SUCCESS, "Opened the observer", url)
        else:
            reporter.message(Level.WARNING, "Open this address in your browser", url)
    else:
        raise ConfigurationError(f"Unknown UI action: {action}. Available actions: open, dev, build, install")
    return EXIT_OK


def command_logs(args: Arguments, out: Output) -> int:
    from .core import logs

    source = (args.topic or "system").lower()
    if source == "system":
        lines = logs.system_tail(100)
        if lines is None:
            out.message(Level.INFO, "No system log yet")
            return EXIT_OK
        out.message(Level.INFO, f"System log · last {len(lines)} lines")
        for line in lines:
            out.line(line)
        return EXIT_OK
    if source not in logs.TABLES:
        out.message(Level.WARNING, "Unknown log source", source)
        return EXIT_OK
    table = logs.journal(source)
    if table is None:
        out.message(Level.INFO, "No runtime database yet")
    elif not table.rows:
        out.message(Level.INFO, "No log records found")
    else:
        out.table(table.columns, table.rows, max_width=60)
    return EXIT_OK


def command_config(out: Output) -> int:
    config = configuration.load()
    out.heading("config/defaults.json")
    rows = [(field.label, f"{field.display(field.get(config))} {field.unit}".strip()) for field in configuration.FIELDS]
    out.pairs(rows, width=18)
    out.write()
    out.muted("Edit interactively with ./launcher config in a terminal.")
    return EXIT_OK


def command_test(args: Arguments, out: Output, reporter: LineReporter) -> int:
    scope = (args.topic or "all").lower()
    results = testing.run(scope, reporter)
    out.heading("Test summary")
    out.table(["Stage", "Result", "Duration"],
              [(r.title, "PASS" if r.passed else "FAIL", f"{r.seconds:.1f} s") for r in results])
    failed = [r for r in results if not r.passed]
    if failed:
        out.write()
        out.message(Level.ERROR, f"{len(failed)} of {len(results)} stage(s) failed", failed[0].title)
        if failed[0].detail:
            for line in failed[0].detail.splitlines():
                out.muted("  " + line)
        return EXIT_FAILURE
    out.message(Level.SUCCESS, f"All {len(results)} test stages passed")
    return EXIT_OK


def command_sumo(out: Output, reporter: LineReporter) -> int:
    summary = sumo.run_standalone(reporter)
    out.pairs(summary.items())
    return EXIT_OK


def command_reset(args: Arguments, out: Output, reporter: LineReporter, caps: Capabilities) -> int:
    if not args.yes and caps.interactive:
        out.line("This deletes runtime logs, the SQLite journal, checkpoints, temporary")
        out.line("scenarios and SUMO runs. Maps, saved seeds and configuration are kept.")
        if not out.confirm("Reset runtime state?", default=False):
            out.message(Level.INFO, "Reset cancelled")
            return EXIT_OK
    maintenance.reset(reporter)
    return EXIT_OK


def command_diagnostics(args: Arguments, out: Output, reporter: LineReporter) -> int:
    from .core import build, compute, environment
    from .core.environment import State

    if (args.topic or "").lower() == "gpu":
        build.ensure_built(reporter)
        config = configuration.load()
        result = compute.probe(config=config, refresh=True)
        out.heading("GPU acceleration")
        out.pairs([("Policy", compute.policy(config)),
                   ("Vulkan loader", f"{result.loader or 'not found'}" + (f" · instance {result.instance_version}" if result.instance_version else "")),
                   ("Selected", result.headline())], width=16)
        if result.devices:
            out.write()
            out.table(["#", "Device", "Driver", "Type", "Vulkan", "Self-test"],
                      [(str(d.index) + (" *" if d.selected else ""), d.name, d.driver, d.type, d.api,
                        "passed" if d.self_test else ("failed: " + d.error[:60] if d.self_test is False else d.reason or "-"))
                       for d in result.devices], max_width=44)
            out.muted("  * the device DSTNS uses. A device counts as available only after a real dispatch returned the right answer.")
        if not result.available:
            out.write()
            out.message(Level.WARNING, "No usable GPU: the simulation runs on the CPU backend", result.reason)
            fix = compute.remedy(result)
            if fix:
                out.muted("  " + fix)
            return 3
        out.message(Level.SUCCESS, "GPU acceleration available", f"tested in {result.seconds:.1f} s")
        return EXIT_OK
    if args.topic not in (None, "environment"):
        raise ConfigurationError(f"Unknown diagnostics topic: {args.topic}", remedy="Use ./launcher diagnostics or ./launcher diagnostics gpu.")
    items = environment.checks()
    environment.run_checks(items)
    out.heading("Environment")
    for group, title in (("", "Required and optional"), ("gpu", "GPU acceleration")):
        out.write()
        out.muted(title)
        for check in (c for c in items if c.group == group):
            out.status(check.outcome.state, check.name, check.outcome.value)
            if check.outcome.state in (State.FAIL, State.WARNING) and check.outcome.remedy:
                out.muted("          " + check.outcome.remedy)
    blocking = environment.blocking(items)
    return EXIT_FAILURE if blocking else EXIT_OK


def command_bootstrap(args: Arguments, out: Output, reporter: LineReporter, caps: Capabilities) -> int:
    from .core import dependencies

    target = dependencies.detect_platform()
    profile = args.profile or "standard"
    the_plan = dependencies.plan(target, profile, assume_yes=args.yes)
    out.heading(f"Dependencies · {target.describe()} · {profile} profile")
    for status in the_plan.statuses:
        state = Level.SUCCESS if status.present else Level.WARNING
        out.message(state, status.dependency.name, (status.found or "missing")[:70])
    for name, what in the_plan.manual:
        out.muted(f"  {name}: {what}")
    for note in the_plan.notes:
        out.muted("  " + note)
    if not the_plan.needed:
        out.write()
        out.message(Level.SUCCESS if not the_plan.manual else Level.WARNING,
                    "Nothing to install" if not the_plan.manual else "Nothing DSTNS can install for you; see above")
        return EXIT_OK if not the_plan.missing else EXIT_FAILURE
    out.write()
    out.line("To install the missing packages, DSTNS would run:")
    for command in the_plan.commands:
        out.line("  " + " ".join(command))
    if args.check:
        return EXIT_FAILURE
    if not args.yes:
        if not caps.interactive:
            raise ConfigurationError("Not installing without confirmation.", remedy="Run ./launcher bootstrap --yes to install.")
        if not out.confirm("Install them now?", default=False):
            out.message(Level.INFO, "Nothing was installed")
            return EXIT_OK
    after = dependencies.execute(the_plan, reporter)
    return EXIT_OK if all(s.present for s in after) else EXIT_FAILURE


def command_start_headless(args: Arguments, out: Output, reporter: LineReporter, session: Session) -> int:
    """Start without a terminal: follow the server and report its fate as our own."""
    session.launch(args.run, reporter, open_browser=args.open)
    handle = session.handle
    if handle is None or handle.process is None:
        return EXIT_OK
    code = handle.process.wait()
    return EXIT_OK if code in (0, -signal.SIGTERM) else EXIT_FAILURE


# --- Interfaces ----------------------------------------------------------------


def run_interactive(args: Arguments, caps: Capabilities, session: Session, initial: str) -> int:
    """The Textual interface, or compatibility mode if it cannot run."""
    from .fallback.app import run_fallback

    if args.no_tui or caps.term == "dumb":
        return run_fallback(args, caps, session, initial, rich=False)
    if args.reduced_ui:
        return run_fallback(args, caps, session, initial, rich=True)
    try:
        from .tui.app import run_tui

        outcome = run_tui(args, caps, session, initial)
    except Exception as exc:  # noqa: BLE001 - any failure to run the interface means: use compatibility mode
        LOG.error("advanced interface failed: %s", exc, exc_info=True)
        return _switch_to_fallback(args, caps, session, initial, exc)
    if outcome.reduced:
        LOG.info("operator switched to compatibility mode")
        return run_fallback(args, caps, session, outcome.resume or initial, rich=True)
    if outcome.error is not None:
        LOG.error("advanced interface stopped: %s", outcome.error,
                  exc_info=(type(outcome.error), outcome.error, outcome.error.__traceback__))
        return _switch_to_fallback(args, caps, session, outcome.resume or initial, outcome.error)
    return outcome.code


def _switch_to_fallback(args: Arguments, caps: Capabilities, session: Session, initial: str, exc: BaseException) -> int:
    from .fallback.app import run_fallback

    print()
    print(f"{PRODUCT} Launcher")
    print()
    print("The enhanced terminal interface could not be started.")
    print("Switching to compatibility mode.")
    print()
    print("Reason:")
    print(f"  {_reason(exc)}")
    print(f"  Details: {PATHS.launcher_log}")
    if args.debug:
        traceback.print_exception(type(exc), exc, exc.__traceback__)
    print()
    return run_fallback(args, caps, session, initial, rich=True)


def _reason(exc: BaseException) -> str:
    if isinstance(exc, ImportError):
        return "The Textual package is not installed."
    if isinstance(exc, DSTNSLauncherError):
        return str(exc)
    return "Terminal UI initialization failed."


# --- Entry point -----------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    debug = "--debug" in argv
    logsetup.configure(debug=debug, echo=debug)
    caps = detect(no_color="--no-color" in argv)
    out = make_output(caps, rich=False)
    session = Session()
    try:
        args = parse(argv)
        if args.no_color:
            os.environ["NO_COLOR"] = "1"
        # Server settings travel in the environment, which the server reads and
        # which beats the configuration file (core/compute.py).
        if args.compute:
            os.environ["DSTNS_COMPUTE_BACKEND"] = args.compute
        if args.gpu_device:
            os.environ["DSTNS_GPU_DEVICE"] = args.gpu_device
        LOG.info("arguments: %s · terminal: %s", " ".join(argv) or "(none)", caps.summary())
        reporter = LineReporter(out, verbose=args.verbose)
        return dispatch(args, caps, out, reporter, session)
    except KeyboardInterrupt:
        print()
        return EXIT_INTERRUPTED
    except DSTNSLauncherError as exc:
        LOG.error("%s", exc, exc_info=debug)
        out.message(Level.ERROR, str(exc))
        if exc.remedy:
            for line in exc.remedy.splitlines():
                out.muted("  " + line)
        if exc.detail:
            for line in exc.detail.splitlines()[-14:]:
                out.muted("  " + line)
        if debug:
            traceback.print_exc()
        return EXIT_FAILURE
    except Exception as exc:  # noqa: BLE001 - the outermost boundary: log, explain, exit non-zero
        LOG.critical("unexpected error", exc_info=True)
        out.message(Level.ERROR, f"Unexpected error: {exc}")
        out.muted(f"  Details have been written to {PATHS.launcher_log}")
        if debug:
            traceback.print_exc()
        return EXIT_FAILURE
    finally:
        session.cleanup()


def dispatch(args: Arguments, caps: Capabilities, out: Output, reporter: LineReporter, session: Session) -> int:
    command = args.command
    if args.mode == "server":
        return server.run_foreground()
    if command == "help":
        print(HELP, end="")
        return EXIT_OK
    if command == "version":
        print(f"{PRODUCT} {engine_version()}")
        for line in licence_lines(caps.unicode):
            print(line)
        return EXIT_OK
    if command == "license":
        try:
            print((PATHS.root / "LICENSE").read_text(encoding="utf-8"), end="")
        except OSError:
            print("GNU Affero General Public License v3 or later — https://www.gnu.org/licenses/agpl-3.0.html")
        return EXIT_OK
    if command == "seeds":
        return command_seeds(args, out)
    if command == "ui":
        return command_ui(args, out, reporter)
    if command == "test":
        return command_test(args, out, reporter)
    if command == "sumo":
        return command_sumo(out, reporter)
    if command == "reset":
        return command_reset(args, out, reporter, caps)
    if command == "diagnostics":
        return command_diagnostics(args, out, reporter)
    if command == "bootstrap":
        return command_bootstrap(args, out, reporter, caps)
    if command == "logs" and (args.topic or not caps.interactive):
        return command_logs(args, out)
    if command == "config" and not caps.interactive:
        return command_config(out)
    if command is not None and command not in COMMANDS:
        raise ConfigurationError(f"Unknown command: {command}", remedy="./launcher help lists every command.")

    if command is None:
        command = "start" if (args.run.explicit() or not caps.interactive) else "console"
    if command == "start" and not caps.interactive:
        _install_signal_handlers(session)
        return command_start_headless(args, out, reporter, session)
    if not caps.interactive:
        print(HELP, end="")
        return EXIT_OK
    initial = {"console": "home", "start": "start", "config": "config", "logs": "logs"}[command]
    _install_signal_handlers(session, terminate_only=True)
    return run_interactive(args, caps, session, initial)


def _install_signal_handlers(session: Session, terminate_only: bool = False) -> None:
    def on_terminate(signum, _frame) -> None:
        LOG.info("signal %s: cleaning up", signum)
        session.cleanup()
        raise SystemExit(EXIT_TERMINATED if signum == signal.SIGTERM else EXIT_INTERRUPTED)

    signal.signal(signal.SIGTERM, on_terminate)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, on_terminate)  # the terminal was closed
    if not terminate_only:
        signal.signal(signal.SIGINT, on_terminate)


def entry() -> int:
    from .bootstrap import ensure_interface

    ensure_interface(sys.argv[1:])
    return main()
