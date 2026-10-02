# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The command line, interface selection and fallback, and the Textual interface."""
from __future__ import annotations

import asyncio
import contextlib
import io
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fakes import ROOT, Workspace  # noqa: E402

from dstns_launcher import cli  # noqa: E402
from dstns_launcher.core.errors import ConfigurationError  # noqa: E402
from dstns_launcher.core.session import Session  # noqa: E402
from dstns_launcher.core.terminal import Capabilities, Colors  # noqa: E402

try:
    from dstns_launcher.bootstrap import has_textual

    TEXTUAL = has_textual()
except Exception:  # noqa: BLE001
    TEXTUAL = False


def caps(interactive: bool = True, width: int = 120, height: int = 35, colors: Colors = Colors.TRUECOLOR,
         unicode: bool = True) -> Capabilities:
    return Capabilities(interactive, width, height, colors, unicode, "xterm-256color")


def run_main(argv: list[str]) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()), \
            mock.patch.object(cli, "detect", return_value=caps(interactive=False, colors=Colors.NONE)):
        code = cli.main(argv)
    return code, out.getvalue()


class Arguments(unittest.TestCase):
    def test_every_existing_flag_is_accepted(self):
        args = cli.parse(["start", "--seed", "42", "--saved-seed", "s", "--save-seed", "t", "--description", "d",
                          "--day-type", "weekend", "--duration", "600", "--speed", "2", "--max-nodes", "100",
                          "--osm-file", "f.osm", "--no-open", "--yes", "--verbose", "--no-splash"])
        self.assertEqual((args.command, args.run.seed, args.run.day_type, args.run.osm_file, args.open, args.yes),
                         ("start", "42", "weekend", "f.osm", False, True))
        self.assertEqual(cli.parse(["--mode=server"]).mode, "server")
        self.assertEqual(cli.parse(["--mode", "server"]).mode, "server")
        self.assertEqual(cli.parse(["--licence"]).command, "license")
        self.assertEqual(cli.parse(["-V"]).command, "version")
        self.assertEqual(cli.parse(["seeds", "inspect", "x"]).item, "x")

    def test_new_interface_flags(self):
        args = cli.parse(["--reduced-ui", "--no-tui", "--no-color", "--no-animation", "--debug"])
        self.assertTrue(args.reduced_ui and args.no_tui and args.no_color and args.no_animation and args.debug)

    def test_errors_keep_their_messages(self):
        with self.assertRaisesRegex(ConfigurationError, "Unknown option: --bogus"):
            cli.parse(["--bogus"])
        with self.assertRaisesRegex(ConfigurationError, "Missing value for --seed"):
            cli.parse(["--seed"])
        with self.assertRaisesRegex(ConfigurationError, "weekday or weekend"):
            cli.parse(["--day-type", "holiday"])


class ScriptedCommands(unittest.TestCase):
    def test_version_reports_project_metadata(self):
        code, out = run_main(["--version"])
        self.assertEqual(code, 0)
        self.assertRegex(out, r"^DSTNS \d+\.\d+\.\d+\n")
        self.assertIn("Varun Karthic", out)
        self.assertIn("AGPL-3.0-or-later", out)
        self.assertIn("OpenStreetMap contributors", out)

    def test_help_lists_commands_and_new_flags(self):
        code, out = run_main(["help"])
        self.assertEqual(code, 0)
        for text in ("seeds save|list|inspect|delete", "--reduced-ui", "--no-tui", "--no-animation", "--debug", "--mode=server"):
            self.assertIn(text, out)

    def test_failures_exit_non_zero_with_an_explanation(self):
        code, out = run_main(["--bogus"])
        self.assertEqual(code, 1)
        self.assertIn("[ERROR] Unknown option: --bogus", out)
        code, out = run_main(["frobnicate"])
        self.assertEqual(code, 1)
        self.assertIn("Unknown command", out)

    def test_non_interactive_config_prints_values(self):
        code, out = run_main(["config"])
        self.assertEqual(code, 0)
        self.assertIn("Day duration", out)

    def test_licence_prints_the_licence(self):
        code, out = run_main(["license"])
        self.assertEqual(code, 0)
        self.assertIn("GNU AFFERO GENERAL PUBLIC LICENSE", out)


class Selection(unittest.TestCase):
    """Whatever happens to the rich interfaces, a usable launcher remains."""

    def setUp(self) -> None:
        self.args = cli.parse([])

    def test_no_tui_uses_plain_mode(self):
        with mock.patch("dstns_launcher.fallback.app.run_fallback", return_value=0) as fallback:
            self.args.no_tui = True
            cli.run_interactive(self.args, caps(), Session(), "home")
        self.assertFalse(fallback.call_args.kwargs["rich"])

    def test_reduced_ui_uses_rich_mode(self):
        with mock.patch("dstns_launcher.fallback.app.run_fallback", return_value=0) as fallback:
            self.args.reduced_ui = True
            cli.run_interactive(self.args, caps(), Session(), "home")
        self.assertTrue(fallback.call_args.kwargs["rich"])

    @unittest.skipUnless(TEXTUAL, "Textual 8 is not installed")
    def test_textual_failing_to_start_falls_back_without_a_traceback(self):
        out = io.StringIO()
        with mock.patch("dstns_launcher.tui.app.run_tui", side_effect=RuntimeError("no terminal")), \
                mock.patch("dstns_launcher.fallback.app.run_fallback", return_value=0) as fallback, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()) as err:
            code = cli.run_interactive(self.args, caps(), Session(), "start")
        self.assertEqual(code, 0)
        self.assertEqual(fallback.call_args.args[3], "start")
        self.assertIn("Switching to compatibility mode.", out.getvalue())
        self.assertIn("Terminal UI initialization failed.", out.getvalue())
        self.assertNotIn("Traceback", out.getvalue() + err.getvalue())

    def test_missing_textual_is_explained(self):
        out = io.StringIO()
        with mock.patch("dstns_launcher.fallback.app.run_fallback", return_value=0), \
                mock.patch.dict(sys.modules, {"dstns_launcher.tui.app": None}), contextlib.redirect_stdout(out):
            cli.run_interactive(self.args, caps(), Session(), "home")
        self.assertIn("The Textual package is not installed.", out.getvalue())

    @unittest.skipUnless(TEXTUAL, "Textual 8 is not installed")
    def test_a_crash_inside_textual_falls_back(self):
        from dstns_launcher.tui.app import Outcome

        with mock.patch("dstns_launcher.tui.app.run_tui", return_value=Outcome(1, error=ValueError("render"), resume="home")), \
                mock.patch("dstns_launcher.fallback.app.run_fallback", return_value=0) as fallback, \
                contextlib.redirect_stdout(io.StringIO()):
            cli.run_interactive(self.args, caps(), Session(), "home")
        fallback.assert_called_once()

    def test_missing_rich_still_gives_plain_output(self):
        from dstns_launcher.fallback import formatting

        with mock.patch.dict(sys.modules, {"rich.console": None}):
            out = formatting.make_output(caps(), rich=True)
        self.assertIs(type(out), formatting.Output)


class PlainMode(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Workspace()
        self.env = mock.patch.dict(os.environ, {"DSTNS_LOGS_DIR": str(self.workspace.root / "logs"),
                                                "DSTNS_SEED_DB": str(self.workspace.root / "seeds.sqlite3")})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.workspace.cleanup()

    def drive(self, answers: list[str], initial: str = "home") -> str:
        from dstns_launcher.fallback.app import FallbackApp

        replies = iter(answers)
        out = io.StringIO()

        def fake_input(prompt=""):
            out.write(prompt)
            try:
                return next(replies)
            except StopIteration:
                raise EOFError

        with mock.patch("builtins.input", fake_input), contextlib.redirect_stdout(out):
            app = FallbackApp(cli.parse(["--no-open"]), caps(colors=Colors.NONE, unicode=False), Session(), rich=False)
            app.out.stream = out
            code = app.run(initial)
        self.assertEqual(code, 0)
        return out.getvalue()

    def test_about_shows_licence_and_attribution(self):
        text = self.drive(["8", "", "9"])
        for expected in ("AGPL-3.0-or-later", "(C) 2026 Varun Karthic", "(C) OpenStreetMap contributors",
                         "Open Data Commons Open Database License (ODbL)", "9. Exit"):
            self.assertIn(expected, text)
        self.assertNotIn("\x1b[", text, "no colour when the terminal has none")

    def test_invalid_configuration_is_explained_and_not_saved(self):
        from dstns_launcher.core import configuration

        load, save = configuration.load, configuration.save
        with mock.patch("dstns_launcher.fallback.app.configuration.load",
                        side_effect=lambda *a, **k: load(self.workspace.paths)), \
                mock.patch("dstns_launcher.fallback.app.configuration.save",
                           side_effect=lambda config, *a, **k: save(config, self.workspace.paths)):
            text = self.drive(["2", "-10", "b", "9"], initial="config")
        self.assertIn("Day duration: Must be between 60 and 3600.", text)
        self.assertEqual(load(self.workspace.paths)["playback"]["duration_seconds"], 3600)

    def test_end_of_input_exits_cleanly(self):
        self.drive([])


@unittest.skipUnless(TEXTUAL, "Textual 8 is not installed")
class TextualInterface(unittest.TestCase):
    SIZES = [(160, 45), (120, 35), (100, 30), (80, 24), (70, 20), (60, 18), (50, 15)]

    def make(self, width: int, height: int, *, colors: Colors = Colors.TRUECOLOR, initial: str = "home", argv=None):
        from dstns_launcher.tui.app import LauncherApp

        return LauncherApp(cli.parse(argv or ["--no-open", "--no-splash"]), caps(width=width, height=height, colors=colors),
                           Session(), initial)

    def run_pilot(self, app, width: int, height: int, script):
        async def go():
            async with app.run_test(size=(width, height)) as pilot:
                for _ in range(120):
                    await pilot.pause(0.1)
                    if type(app.screen).__name__ not in ("SplashScreen", "EnvironmentScreen"):
                        break
                await pilot.pause(0.4)
                await script(pilot)
        asyncio.run(go())
        if app.launcher_error:
            raise app.launcher_error

    def test_reaches_the_dashboard_and_navigates_by_keyboard(self):
        app = self.make(120, 35)

        async def script(pilot):
            self.assertEqual(type(app.screen).__name__, "DashboardScreen")
            menu = app.screen.query_one("#menu")
            first = menu.current.key
            await pilot.press("down", "j")
            self.assertEqual(menu.index, 2)
            await pilot.press("k", "home")
            self.assertEqual(menu.current.key, first)
            await pilot.press("end")
            self.assertEqual(menu.current.key, "exit")
            await pilot.press("home", "down", "down", "enter")
            await pilot.pause(0.3)
            self.assertEqual(type(app.screen).__name__, "ConfigurationScreen")
            await pilot.press("escape")
            await pilot.pause(0.2)
            self.assertEqual(type(app.screen).__name__, "DashboardScreen")
            await pilot.press("question_mark")
            await pilot.pause(0.2)
            self.assertEqual(type(app.screen).__name__, "HelpDialog")
            await pilot.press("escape")

        self.run_pilot(app, 120, 35, script)

    def test_selection_is_visible_without_colour(self):
        app = self.make(100, 30, colors=Colors.NONE)

        async def script(pilot):
            rendered = app.screen.query_one("#menu").render().plain
            self.assertTrue(rendered.splitlines()[0].startswith("> "))
            self.assertTrue(rendered.splitlines()[1].startswith("  "))

        self.run_pilot(app, 100, 30, script)

    def test_no_widget_extends_past_the_terminal(self):
        for width, height in self.SIZES:
            with self.subTest(size=(width, height)):
                app = self.make(width, height)

                async def script(pilot, width=width, height=height):
                    for keys in ([], ["enter"], ["escape", "down", "down", "enter"], ["escape", "end", "up", "enter"]):
                        for key in keys:
                            await pilot.press(key)
                        await pilot.pause(0.3)
                        for widget in app.screen.query("*"):
                            if widget.display and widget.region.width:
                                self.assertLessEqual(widget.region.right, width,
                                                     f"{type(app.screen).__name__} {widget!r} at {width}x{height}")

                self.run_pilot(app, width, height, script)

    def test_layout_classes_follow_the_size_and_state_survives_resizing(self):
        app = self.make(120, 35)

        async def script(pilot):
            await pilot.press("down", "down")
            menu = app.screen.query_one("#menu")
            for (width, height), expected in (((80, 24), "-medium"), ((60, 18), "-small"), ((120, 35), "-large")):
                await pilot.resize_terminal(width, height)
                await pilot.pause(0.3)
                self.assertTrue(app.has_class(expected), (width, height))
                self.assertEqual(menu.index, 2)
            await pilot.resize_terminal(40, 12)
            await pilot.pause(0.3)
            self.assertEqual(type(app.screen).__name__, "TooSmallScreen")
            await pilot.resize_terminal(100, 30)
            await pilot.pause(0.3)
            self.assertEqual(type(app.screen).__name__, "DashboardScreen")
            self.assertEqual(app.screen.query_one("#menu").index, 2)

        self.run_pilot(app, 120, 35, script)

    def test_configuration_validates_and_guards_unsaved_changes(self):
        workspace = Workspace()
        try:
            from dstns_launcher.core import configuration

            original_load, original_save = configuration.load, configuration.save
            with mock.patch("dstns_launcher.tui.screens.configuration.configuration.load",
                            side_effect=lambda *a, **k: original_load(workspace.paths)), \
                    mock.patch("dstns_launcher.tui.screens.configuration.configuration.save",
                               side_effect=lambda config, *a, **k: original_save(config, workspace.paths)):
                app = self.make(120, 35, initial="config")

                async def script(pilot):
                    await pilot.pause(0.3)
                    screen = app.screen
                    self.assertEqual(type(screen).__name__, "ConfigurationScreen")
                    duration = screen.query_one("#field-playback-duration_seconds Input")
                    duration.value = "-10"
                    await pilot.pause(0.2)
                    self.assertIn("playback.duration_seconds", screen.invalid)
                    await pilot.press("ctrl+s")
                    await pilot.pause(0.2)
                    duration.value = "1200"
                    await pilot.pause(0.2)
                    self.assertTrue(screen.dirty and not screen.invalid)
                    await pilot.press("escape")
                    await pilot.pause(0.2)
                    self.assertEqual(type(app.screen).__name__, "ChoiceDialog")
                    await pilot.press("enter")  # Save and continue
                    await pilot.pause(0.3)

                self.run_pilot(app, 120, 35, script)
            self.assertEqual(original_load(workspace.paths)["playback"]["duration_seconds"], 1200)
        finally:
            workspace.cleanup()

    def test_a_crash_is_recorded_for_the_fallback(self):
        from dstns_launcher.tui.screens import dashboard

        app = self.make(100, 30)

        async def go():
            with mock.patch.object(dashboard.DashboardScreen, "describe", side_effect=ValueError("broken panel")):
                async with app.run_test(size=(100, 30)) as pilot:
                    await pilot.pause(2)

        with self.assertRaises(ValueError):
            asyncio.run(go())
        self.assertIsInstance(app.launcher_error, ValueError)

    def test_quit_with_no_simulation_exits_immediately(self):
        app = self.make(100, 30)

        async def script(pilot):
            await pilot.press("ctrl+c")
            await pilot.pause(0.2)

        self.run_pilot(app, 100, 30, script)
        self.assertEqual(app.return_value.code, 0)


class BootstrapRecovery(unittest.TestCase):
    def test_dumb_terminal_does_not_install_or_open_textual(self):
        from dstns_launcher import bootstrap

        with mock.patch.dict(os.environ, {"TERM": "dumb"}), \
                mock.patch.object(sys.stdin, "isatty", return_value=True), \
                mock.patch.object(sys.stdout, "isatty", return_value=True):
            self.assertFalse(bootstrap.wants_interface([]))
        terminal = Capabilities(True, 80, 24, Colors.NONE, False, "dumb")
        with mock.patch("dstns_launcher.fallback.app.run_fallback", return_value=0) as reduced:
            cli.run_interactive(cli.parse([]), terminal, Session(), "home")
        self.assertFalse(reduced.call_args.kwargs["rich"])

    def test_unusable_private_interpreter_keeps_the_launcher_available(self):
        from dstns_launcher import bootstrap

        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(bootstrap, "wants_interface", return_value=True), \
                mock.patch.object(bootstrap, "has_textual", return_value=False), \
                mock.patch.object(bootstrap, "_installed", return_value=True), \
                mock.patch.object(bootstrap, "venv_python", return_value=Path(sys.executable)), \
                mock.patch.object(os, "execve", side_effect=OSError("interpreter unavailable")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            bootstrap.ensure_interface([])
        self.assertIn("using compatibility mode", output.getvalue())


@unittest.skipUnless(TEXTUAL, "Textual 8 is not installed")
class LoadingFeedback(unittest.IsolatedAsyncioTestCase):
    async def test_splash_holds_identity_and_runs_real_checks_once(self):
        import time
        from dstns_launcher.core.environment import Check, Outcome, State
        from dstns_launcher.tui.app import LauncherApp
        from dstns_launcher.tui.widgets import Activity

        check_run = mock.Mock(return_value=Outcome(State.PASS, "Ready"))
        check = Check("test", "Startup self-test", check_run)
        app = LauncherApp(cli.parse(["--no-animation"]), caps(), Session(), "home")
        with mock.patch("dstns_launcher.tui.screens.splash.environment.checks", return_value=[check]):
            async with app.run_test(size=(100, 30)) as pilot:
                await pilot.pause(.2)
                self.assertEqual(type(app.screen).__name__, "SplashScreen")
                splash = app.screen
                self.assertFalse(splash.query_one(Activity).busy, "completed checks must not keep spinning")
                self.assertEqual(splash.query_one(Activity).render().plain, "Startup checks complete")
                await pilot.pause(1)
                self.assertIs(app.screen, splash)
                for _ in range(60):
                    if type(app.screen).__name__ == "DashboardScreen":
                        break
                    await pilot.pause(.05)
                self.assertEqual(type(app.screen).__name__, "DashboardScreen")
                self.assertGreaterEqual(time.monotonic() - splash.started, 3)
                self.assertEqual(app.checks, [check])
                check_run.assert_called_once()

    async def test_splash_failure_opens_results_without_repeating_checks(self):
        from dstns_launcher.core.environment import Check, Outcome, State
        from dstns_launcher.tui.app import LauncherApp
        from dstns_launcher.tui.screens.splash import SplashScreen

        check_run = mock.Mock(return_value=Outcome(State.FAIL, "Invalid configuration", remedy="Fix the configuration"))
        check = Check("test", "Configuration", check_run)
        app = LauncherApp(cli.parse([]), caps(), Session(), "home")
        with mock.patch("dstns_launcher.tui.screens.splash.environment.checks", return_value=[check]), \
                mock.patch.object(SplashScreen, "MINIMUM_SECONDS", .1):
            async with app.run_test(size=(50, 15)) as pilot:
                for _ in range(30):
                    await pilot.pause(.05)
                    if type(app.screen).__name__ == "EnvironmentScreen":
                        break
                self.assertEqual(type(app.screen).__name__, "EnvironmentScreen")
                self.assertTrue(app.screen.done)
                self.assertTrue(app.screen.query_one("#actions").display)
                check_run.assert_called_once()

    async def test_small_running_screen_keeps_progress_and_log_visible(self):
        from dstns_launcher.core.simulation import Metrics, Status, World
        from dstns_launcher.tui.app import LauncherApp
        from dstns_launcher.tui.screens.running import RunningScreen

        app = LauncherApp(cli.parse(["--no-splash"]), caps(), Session(), "home")
        with mock.patch("dstns_launcher.tui.screens.environment.environment.checks", return_value=[]), \
                mock.patch.object(RunningScreen, "launch"), mock.patch.object(RunningScreen, "poll"):
            async with app.run_test(size=(50, 15)) as pilot:
                await pilot.pause(.1)
                page = RunningScreen(options=cli.parse([]).run)
                app.open(page)
                await pilot.pause(.1)
                app.session.world = World("382923", 0)
                page.status = Status(True, "RUNNING", seed="382923", tick_rate=1, fraction=.25)
                page.figures = Metrics(vehicles=300, congestion=10, closed_roads=0, storms=0)
                page.launched()
                page.render_facts()
                await pilot.pause(.1)
                footer = page.query_one("#keys").region
                for selector in ("#progress-line", "#log"):
                    region = page.query_one(selector).region
                    self.assertGreater(region.height, 0)
                    self.assertLessEqual(region.bottom, footer.y)
                names = [row.name for row in page.query_one("#facts").rows]
                self.assertIn("Simulation time", names)
                self.assertNotIn("Storms", names)
                await pilot.resize_terminal(120, 35)
                await pilot.pause(.1)
                self.assertIn("Storms", [row.name for row in page.query_one("#facts").rows])

    async def test_no_splash_still_checks_environment_and_handles_tiny_terminal(self):
        from dstns_launcher.tui.app import LauncherApp
        from dstns_launcher.tui.screens.splash import SplashScreen

        app = LauncherApp(cli.parse(["--no-splash", "--no-animation"]), caps(), Session(), "home")
        with mock.patch.object(SplashScreen, "initialise", side_effect=AssertionError("splash must be skipped")):
            async with app.run_test(size=(40, 12)) as pilot:
                await pilot.pause(1)
                self.assertEqual(type(app.screen).__name__, "TooSmallScreen")
                await pilot.resize_terminal(100, 30)
                for _ in range(100):
                    await pilot.pause(.05)
                    if type(app.screen).__name__ == "DashboardScreen":
                        break
                self.assertEqual(type(app.screen).__name__, "DashboardScreen")
                self.assertIsNotNone(app.checks)

    async def test_activity_moves_only_during_work_and_can_disable_motion(self):
        from textual.app import App, ComposeResult
        from dstns_launcher.tui.widgets import Activity

        class Demo(App):
            motion = True

            def compose(self) -> ComposeResult:
                yield Activity("Loading the map", id="activity")

        app = Demo()
        async with app.run_test(size=(50, 15)) as pilot:
            activity = app.query_one(Activity)
            first = activity.render().plain
            await pilot.pause(.3)
            self.assertNotEqual(first, activity.render().plain)
            self.assertIn("Loading the map", activity.render().plain)
            self.assertNotIn("%", activity.render().plain)
            activity.stop("Ready")
            frame = activity.frame
            await pilot.pause(.35)
            self.assertEqual(activity.frame, frame)
            self.assertEqual(activity.render().plain, "Ready")
            app.motion = False
            activity.start("Preparing")
            await pilot.pause(.35)
            self.assertEqual(activity.frame, frame)
            self.assertEqual(activity.render().plain, "[working] Preparing")
            await activity.remove()
            self.assertFalse(activity.busy)

    async def test_environment_animation_is_tied_to_actual_check_completion(self):
        import threading
        from dstns_launcher.core.environment import Check, Outcome, State
        from dstns_launcher.tui.app import LauncherApp
        from dstns_launcher.tui.widgets import Activity

        finished = threading.Event()
        check = Check("test", "Blocked check", lambda: (finished.wait(5), Outcome(State.PASS, "Ready"))[1])
        app = LauncherApp(cli.parse(["--no-splash"]), caps(), Session(), "home")
        try:
            with mock.patch("dstns_launcher.tui.screens.environment.environment.checks", return_value=[check]):
                async with app.run_test(size=(100, 30)) as pilot:
                    await pilot.pause(.1)
                    activity = app.screen.query_one(Activity)
                    first = activity.frame
                    await pilot.pause(.3)
                    self.assertNotEqual(first, activity.frame)
                    self.assertIn("0/1 complete", activity.render().plain)
                    finished.set()
                    for _ in range(40):
                        await pilot.pause(.05)
                        if type(app.screen).__name__ == "DashboardScreen":
                            break
                    self.assertEqual(type(app.screen).__name__, "DashboardScreen")
                    self.assertFalse(activity.busy)
        finally:
            finished.set()

    async def test_preparation_progress_never_invents_a_percentage(self):
        from dstns_launcher.tui.app import LauncherApp
        from dstns_launcher.tui.screens.running import RunningScreen
        from dstns_launcher.tui.widgets import Activity

        app = LauncherApp(cli.parse(["--no-splash", "--no-animation"]), caps(), Session(), "home")
        async with app.run_test(size=(80, 24)) as pilot:
            for _ in range(100):
                await pilot.pause(.05)
                if type(app.screen).__name__ == "DashboardScreen":
                    break
            with mock.patch.object(RunningScreen, "launch"):
                page = RunningScreen(options=cli.parse([]).run)
                app.open(page)
                await pilot.pause(.1)
            activity = page.query_one(Activity)
            self.assertTrue(activity.busy)
            self.assertFalse(page.query_one("#progress-line").display)
            page.progress("Downloading map", 1048576, None)
            self.assertIn("1.0 MiB", activity.render().plain)
            self.assertFalse(page.query_one("#progress-line").display)
            page.progress("Downloading map", 1048576, 2097152)
            self.assertTrue(page.query_one("#progress-line").display)
            self.assertEqual(page.query_one("#progress").percentage, .5)
            page.progress_done()
            self.assertFalse(page.query_one("#progress-line").display)
            page.cancel.set()
            page.launch_failed(ConfigurationError("Cancelled"))
            await pilot.pause(.1)
            self.assertFalse(activity.busy)


if __name__ == "__main__":
    unittest.main()
