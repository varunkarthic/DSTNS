# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The application catalogue, and starting and looking after real processes."""
from __future__ import annotations

import io
import json
import contextlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fakes import FakeServer, Workspace  # noqa: E402

from dstns_launcher import cli  # noqa: E402
from dstns_launcher.core import apps as catalogue  # noqa: E402
from dstns_launcher.core.apps import App  # noqa: E402
from dstns_launcher.core.configuration import RunOptions  # noqa: E402
from dstns_launcher.core.errors import ConfigurationError  # noqa: E402
from dstns_launcher.core.supervisor import AppStartError, Phase, Supervisor, expand  # noqa: E402
from dstns_launcher.modules import find_command, help_lines  # noqa: E402

PY = sys.executable


def stays(extra: str = "") -> str:
    return f"{PY} -c \"import time{extra}; time.sleep(60)\""


class Catalogue(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Workspace()
        self.addCleanup(self.workspace.cleanup)
        self.paths = self.workspace.paths
        self.file = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.file.close()
        os.unlink(self.file.name)
        os.environ["DSTNS_APPS_FILE"] = self.file.name
        self.addCleanup(lambda: os.environ.pop("DSTNS_APPS_FILE", None))
        self.addCleanup(lambda: os.path.exists(self.file.name) and os.unlink(self.file.name))

    def test_saves_and_loads_what_it_was_given(self) -> None:
        app = App("org.example.one", name="One", commands=["python3 a.py", "python3 b.py --url {url}"], env={"A": "1"}, grants=["sim.read"], settings={"x": 2}, required=True)
        catalogue.put(app, self.paths)
        self.assertEqual(catalogue.get("org.example.one", self.paths), app)
        catalogue.remove("org.example.one", self.paths)
        self.assertEqual(catalogue.load(self.paths), {})
        with self.assertRaises(ConfigurationError):
            catalogue.remove("org.example.one", self.paths)

    def test_refuses_what_could_not_run(self) -> None:
        for bad in (App("X", commands=["a"]), App("ab", commands=["a"]), App("org.example.a"), App("org.example.a", commands=["unterminated 'quote"]),
                    App("org.example.a", commands=["a"], ready="whenever"), App("org.example.a", commands=["a"], timeout_s=0), App("org.example.a", commands=["a"], restart="always"),
                    App("org.example.a", commands=["a"] * 9), App("org.example.a", commands=["x" * 2000])):
            with self.assertRaises(ConfigurationError, msg=str(bad)):
                catalogue.validate(bad)

    def test_an_application_cannot_be_given_the_operators_credential(self) -> None:
        with self.assertRaises(ConfigurationError):
            catalogue.validate(App("org.example.a", commands=["a"], env={"DSTNS_OPERATOR_TOKEN": "x"}))

    def test_a_run_starts_what_it_names_or_else_what_starts_by_itself(self) -> None:
        catalogue.put(App("org.example.auto", commands=["a"], autostart=True), self.paths)
        catalogue.put(App("org.example.other", commands=["a"]), self.paths)
        ids = lambda options: [app.id for app in catalogue.selection(options, self.paths)]  # noqa: E731
        self.assertEqual(ids(RunOptions()), ["org.example.auto"])
        self.assertEqual(ids(RunOptions(apps="org.example.other")), ["org.example.other"])
        self.assertEqual(ids(RunOptions(apps="")), [])
        self.assertEqual(ids(RunOptions(no_apps=True)), [])
        with self.assertRaises(ConfigurationError):
            ids(RunOptions(apps="org.example.nothing"))

    def test_says_what_would_stop_it(self) -> None:
        self.assertEqual(catalogue.problems(App("org.example.a", commands=[f"{PY} -V"]), self.paths), [])
        self.assertIn("not on this machine", " ".join(catalogue.problems(App("org.example.a", commands=["no-such-program-here"]), self.paths)))
        self.assertIn("does not exist", " ".join(catalogue.problems(App("org.example.a", commands=[f"{PY} -V"], cwd="nowhere"), self.paths)))

    def test_commands_are_filled_in_and_never_go_through_a_shell(self) -> None:
        self.assertEqual(expand("run --url {url} '$(rm -rf x)' {id}", {"url": "http://h", "port": "1", "id": "a.b", "root": "/r"}), ["run", "--url", "http://h", "$(rm -rf x)", "a.b"])


class Supervision(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Workspace()
        self.addCleanup(self.workspace.cleanup)
        self.server = FakeServer().__enter__()
        self.addCleanup(self.server.__exit__, None, None, None)
        self.supervisor = Supervisor(self.server.port, paths=self.workspace.paths)
        self.addCleanup(self.supervisor.stop_all)

    def app(self, **fields) -> App:
        return App(**{"id": "org.example.app", "ready": "process", "timeout_s": 8, **fields})

    def test_waits_until_every_one_is_ready(self) -> None:
        began = time.monotonic()
        self.supervisor.launch([self.app(commands=[stays()]), self.app(id="org.example.later", commands=[stays()], ready="delay:1.5")])
        self.assertGreaterEqual(time.monotonic() - began, 1.5)
        self.assertEqual({state.phase for state in self.supervisor.states()}, {Phase.READY})
        # And the observer was told along the way, and told when it was over.
        plans = [body for method, path, body in self.server.requests if path.endswith("/launch/plan")]
        self.assertTrue(any(body and body["apps"][0]["state"] == "starting" for body in plans), plans)
        self.assertEqual([method for method, path, _ in self.server.requests if path.endswith("/launch/plan")][-1], "DELETE")

    def test_commands_run_in_order_and_the_last_stays(self) -> None:
        mark = self.workspace.paths.root / "prepared"
        self.supervisor.launch([self.app(commands=[f"{PY} -c \"open('{mark}', 'w')\"", f"{PY} -c \"import os, time; assert os.path.exists('{mark}'); time.sleep(60)\""])])
        self.assertEqual(self.supervisor.states()[0].phase, Phase.READY)

    def test_a_failed_preparation_stops_there(self) -> None:
        self.supervisor.launch([self.app(commands=[f"{PY} -c \"import sys; print('nope'); sys.exit(3)\"", stays()])])
        state = self.supervisor.states()[0]
        self.assertEqual(state.phase, Phase.FAILED)
        self.assertIn("status 3", state.detail)
        self.assertIn("nope", state.detail)

    def test_a_required_application_stops_the_run_and_an_optional_one_does_not(self) -> None:
        self.supervisor.launch([self.app(commands=[f"{PY} -c \"import sys; sys.exit(1)\""])])
        self.assertEqual(self.supervisor.states()[0].phase, Phase.FAILED)
        with self.assertRaises(AppStartError):
            self.supervisor.launch([self.app(id="org.example.need", commands=[f"{PY} -c \"import sys; sys.exit(1)\""], required=True)])

    def test_gives_up_with_a_reason_when_it_is_never_ready(self) -> None:
        self.supervisor.launch([self.app(commands=[stays()], ready="http://127.0.0.1:9/", timeout_s=1)])
        self.assertIn("not ready within", self.supervisor.states()[0].detail)
        supervisor = Supervisor(self.server.port, paths=self.workspace.paths)
        self.addCleanup(supervisor.stop_all)
        supervisor.launch([self.app(id="org.example.silent", commands=[stays()], ready="fabric", timeout_s=1)])
        self.assertIn("did not register as org.example.silent", supervisor.states()[0].detail)

    def test_restarts_what_it_was_told_to_and_stops_trying(self) -> None:
        count = self.workspace.paths.root / "count"
        script = f"{PY} -c \"import sys; open('{count}', 'a').write('x'); sys.exit(1)\""
        import dstns_launcher.core.supervisor as module

        original = module.RESTART_BACKOFF_S, module.MAX_RESTARTS
        module.RESTART_BACKOFF_S, module.MAX_RESTARTS = 0.01, 2
        self.addCleanup(lambda: setattr(module, "RESTART_BACKOFF_S", original[0]) or setattr(module, "MAX_RESTARTS", original[1]))
        self.supervisor.launch([self.app(commands=[script], restart="on-failure", timeout_s=8)])
        self.assertEqual(count.read_text(), "xxx")
        self.assertIn("Restarted 2 times", self.supervisor.states()[0].detail)

    def test_stopping_stops_everything_it_started(self) -> None:
        pid_file = self.workspace.paths.root / "child"
        parent = f"{PY} -c \"import subprocess, sys, time; child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); open('{pid_file}', 'w').write(str(child.pid)); time.sleep(60)\""
        self.supervisor.launch([self.app(commands=[parent])])
        for _ in range(50):
            if pid_file.exists() and pid_file.read_text():
                break
            time.sleep(0.1)
        child = int(pid_file.read_text())
        self.supervisor.stop_all()
        for _ in range(50):
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            # Reaped by init in its own time; a zombie still answers, so ask how it is.
            if os.popen(f"ps -o stat= -p {child}").read().strip().startswith("Z"):
                break
            time.sleep(0.1)
        else:
            self.fail("what it started is still running")
        self.assertEqual(self.supervisor.states()[0].phase, Phase.STOPPED)

    def test_the_application_is_not_given_the_operators_credential(self) -> None:
        out = self.workspace.paths.root / "env"
        os.environ["DSTNS_OPERATOR_TOKEN"] = "secret"
        self.addCleanup(lambda: os.environ.pop("DSTNS_OPERATOR_TOKEN", None))
        self.supervisor.launch([self.app(commands=[f"{PY} -c \"import json, os, time; json.dump(dict(os.environ), open('{out}', 'w')); time.sleep(60)\""], env={"MINE": "1"})])
        for _ in range(50):
            if out.exists() and out.read_text():
                break
            time.sleep(0.1)
        seen = json.loads(out.read_text())
        self.assertNotIn("DSTNS_OPERATOR_TOKEN", seen)
        self.assertEqual((seen["DSTNS_URL"], seen["MINE"], seen["DSTNS_APP_ID"]), (f"http://127.0.0.1:{self.server.port}", "1", "org.example.app"))


@unittest.skipUnless(__import__("importlib").util.find_spec("textual"), "needs Textual")
class Screens(unittest.TestCase):
    """The Applications page, its form, and choosing applications when starting a run."""

    def setUp(self) -> None:
        self.file = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.file.close()
        os.unlink(self.file.name)
        os.environ["DSTNS_APPS_FILE"] = self.file.name
        self.addCleanup(lambda: os.environ.pop("DSTNS_APPS_FILE", None))
        self.addCleanup(lambda: os.path.exists(self.file.name) and os.unlink(self.file.name))

    def pilot(self, script, size=(120, 35)) -> None:
        import asyncio

        from dstns_launcher.core.session import Session
        from dstns_launcher.core.terminal import Capabilities, Colors
        from dstns_launcher.tui.app import LauncherApp

        app = LauncherApp(cli.parse(["--no-splash", "--no-open"]), Capabilities(True, size[0], size[1], list(Colors)[-1], True, "xterm-256color"), Session(), "home")

        async def run() -> None:
            async with app.run_test(size=size) as pilot:
                for _ in range(80):
                    await pilot.pause(0.1)
                    if app.screen.query("#menu"):
                        break
                await script(app, pilot)

        asyncio.run(run())

    def test_the_dashboard_offers_what_modules_add(self) -> None:
        async def script(app, pilot) -> None:
            menu = app.screen.query_one("#menu")
            self.assertIn("apps", [item.key for item in menu.items])
            menu.select_key("apps")
            await pilot.press("enter")
            await pilot.pause(0.4)
            self.assertEqual(type(app.screen).__name__, "AppsScreen")

        self.pilot(script)

    def test_adds_an_application_from_its_form(self) -> None:
        from textual.widgets import Input, TextArea

        from dstns_launcher.tui.screens.apps import AppEditScreen, AppsScreen

        async def script(app, pilot) -> None:
            app.push_screen(AppsScreen())
            await pilot.pause(0.3)
            await pilot.press("a")
            await pilot.pause(0.3)
            page = app.screen
            self.assertIsInstance(page, AppEditScreen)
            # Nothing to run: it says so beside the field, and nothing is saved.
            page.query_one("#app-id", Input).value = "org.example.form"
            page.action_save()
            await pilot.pause(0.1)
            self.assertIn("-shown", page.query_one("#row-commands .problem").classes)
            self.assertEqual(catalogue.load(), {})
            page.query_one("#app-commands", TextArea).text = f"{PY} -V\n{PY} app.py --url {{url}}"
            page.action_save()
            await pilot.pause(0.3)
            self.assertEqual(catalogue.get("org.example.form").commands, [f"{PY} -V", f"{PY} app.py --url {{url}}"])
            self.assertIsInstance(app.screen, AppsScreen)

        self.pilot(script)

    def test_starting_a_run_offers_each_application(self) -> None:
        from textual.widgets import Switch

        from dstns_launcher.tui.screens.start import StartScreen

        catalogue.put(App("org.example.auto", name="Auto", commands=["a"], autostart=True))
        catalogue.put(App("org.example.other", name="Other", commands=["a"]))

        async def script(app, pilot) -> None:
            app.push_screen(StartScreen())
            await pilot.pause(0.4)
            page = app.screen
            self.assertTrue(page.query_one("#app-org-example-auto", Switch).value)
            self.assertFalse(page.query_one("#app-org-example-other", Switch).value)
            self.assertEqual(page.options().apps, "org.example.auto")
            page.query_one("#app-org-example-auto", Switch).value = False
            page.query_one("#app-org-example-other", Switch).value = True
            self.assertEqual(page.options().apps, "org.example.other")

        self.pilot(script)

    def test_every_size_draws(self) -> None:
        from dstns_launcher.tui.screens.apps import AppsScreen

        catalogue.put(App("org.example.auto", name="Auto", commands=["a"]))

        async def script(app, pilot) -> None:
            app.push_screen(AppsScreen())
            for size in ((60, 18), (80, 24), (160, 50)):
                await pilot.resize_terminal(*size)
                await pilot.pause(0.3)
                self.assertTrue(app.screen.query("#apps"))

        self.pilot(script)


class CommandLine(unittest.TestCase):
    def setUp(self) -> None:
        self.file = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.file.close()
        os.unlink(self.file.name)
        os.environ["DSTNS_APPS_FILE"] = self.file.name
        self.addCleanup(lambda: os.environ.pop("DSTNS_APPS_FILE", None))
        self.addCleanup(lambda: os.path.exists(self.file.name) and os.unlink(self.file.name))

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def test_modules_add_their_commands_and_their_help(self) -> None:
        self.assertIsNotNone(find_command("apps"))
        self.assertIsNotNone(find_command("fabric"))
        self.assertIsNone(find_command("nothing"))
        self.assertTrue(any("apps [list" in line for line in help_lines()))
        code, text = self.run_cli("help")
        self.assertEqual(code, 0)
        self.assertIn("apps [list", text)
        self.assertIn("--apps ID,ID", text)

    def test_adds_changes_shows_and_removes(self) -> None:
        code, text = self.run_cli("apps", "add", "org.example.hi", "--command", f"{PY} -V", "--command", f"{PY} app.py --url {{url}}", "--name", "Hi", "--env", "A=1", "--setting", "level=3", "--required")
        self.assertEqual(code, 0, text)
        self.assertIn("Added Hi", text)
        code, text = self.run_cli("apps", "set", "org.example.hi", "--autostart", "--no-required")
        self.assertEqual(code, 0, text)
        code, text = self.run_cli("apps", "show", "org.example.hi", "--json")
        saved = json.loads(text)
        self.assertEqual((saved["autostart"], saved["required"], saved["settings"], saved["env"]), (True, False, {"level": 3}, {"A": "1"}))
        self.assertEqual(len(saved["commands"]), 2, "what was not given stays as it was")
        code, text = self.run_cli("apps", "add", "org.example.hi", "--command", "x")
        self.assertEqual(code, 1)
        self.assertIn("already exists", text)
        code, text = self.run_cli("apps", "list")
        self.assertIn("org.example.hi", text)
        code, text = self.run_cli("apps", "doctor")
        self.assertEqual(code, 0, text)
        code, text = self.run_cli("apps", "remove", "org.example.hi")
        self.assertEqual(code, 0)
        code, text = self.run_cli("apps", "list")
        self.assertIn("No applications yet", text)

    def test_says_when_a_server_is_needed(self) -> None:
        code, text = self.run_cli("fabric", "status")
        self.assertEqual(code, 1)
        self.assertIn("No server is running", text)


if __name__ == "__main__":
    unittest.main()
