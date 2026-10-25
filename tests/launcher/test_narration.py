# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Narration in the launcher, and the launcher's own files in a synced folder.

The fm command is a stand-in script, so every branch - available, missing, the
model unavailable, the terms not accepted - runs on any machine.
"""
from __future__ import annotations

import http.server
import io
import logging
import os
import socket
import stat
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fakes import Workspace  # noqa: E402

from dstns_launcher import bootstrap, cli  # noqa: E402
from dstns_launcher.core import configuration, environment, logsetup, narration, server  # noqa: E402
from dstns_launcher.core.errors import ConfigurationError, SimulationStartError  # noqa: E402
from dstns_launcher.core.paths import Paths, cloud_synced, local_state_dir  # noqa: E402
from dstns_launcher.core.reporting import Level, Reporter  # noqa: E402


class Recorder(Reporter):
    def __init__(self) -> None:
        self.messages: list[tuple[Level, str, str]] = []

    def message(self, level: Level, text: str, detail: str = "") -> None:
        self.messages.append((level, text, detail))


def fake_fm(directory: Path, *, available: str = "System model available", available_code: int = 0,
            license_text: str = "Agreed to license FM1 version 1.0", license_code: int = 0) -> None:
    script = directory / "fm"
    script.write_text(
        "#!/bin/sh\n"
        f'if [ "$1" = available ]; then echo "{available}"; exit {available_code}; fi\n'
        f'if [ "$1" = license ]; then echo "{license_text}"; exit {license_code}; fi\n'
        "exit 2\n")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)


class WithFm(unittest.TestCase):
    def setUp(self) -> None:
        self.bin = Path(tempfile.mkdtemp(prefix="dstns-fm-"))
        # Only the stand-in is on PATH, so a real fm on this machine is not found.
        self.env = mock.patch.dict(os.environ, {"PATH": str(self.bin)})
        self.env.start()
        os.environ.pop(narration.ENV, None)
        self.mac = mock.patch.object(narration.sys, "platform", "darwin")
        self.mac.start()
        self.no_system_fm = mock.patch.object(narration, "SYSTEM_FM", self.bin / "absent" / "fm")
        self.no_system_fm.start()

    def tearDown(self) -> None:
        self.no_system_fm.stop()
        self.mac.stop()
        self.env.stop()
        for entry in self.bin.iterdir():
            entry.unlink()
        self.bin.rmdir()


class Resolve(WithFm):
    def test_available_model_is_used(self):
        fake_fm(self.bin)
        choice = narration.resolve("auto")
        self.assertEqual(choice.server_argument, "fm")
        self.assertTrue(choice.enabled)
        self.assertIn("Apple Foundation Models", choice.label)

    def test_missing_fm_falls_back_to_the_default_wording(self):
        choice = narration.resolve("auto")
        self.assertEqual(choice.server_argument, "off")
        self.assertTrue(choice.fell_back)
        self.assertIn("fm command was not found", choice.reason)
        self.assertIn("Apple Intelligence", choice.remedy)

    def test_unavailable_model_says_why(self):
        fake_fm(self.bin, available="Model not available: Apple Intelligence is turned off", available_code=1)
        choice = narration.resolve("fm")
        self.assertEqual(choice.server_argument, "off")
        self.assertIn("Apple Intelligence is turned off", choice.reason)

    def test_terms_not_accepted(self):
        fake_fm(self.bin, license_text="You have not agreed to the license.", license_code=1)
        choice = narration.resolve("auto")
        self.assertEqual(choice.server_argument, "off")
        self.assertIn("terms", choice.reason)
        self.assertIn("fm license", choice.remedy)

    def test_not_supported_off_macos(self):
        fake_fm(self.bin)
        with mock.patch.object(narration.sys, "platform", "linux"):
            choice = narration.resolve("auto")
        self.assertEqual(choice.server_argument, "off")
        self.assertIn("only available on macOS", choice.reason)

    def test_off_is_not_a_fallback(self):
        fake_fm(self.bin)
        choice = narration.resolve("off")
        self.assertFalse(choice.enabled)
        self.assertFalse(choice.fell_back)

    def test_endpoints(self):
        class Models(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"data": []}')

        stand_in = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Models)
        threading.Thread(target=stand_in.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{stand_in.server_address[1]}"
            self.assertEqual(narration.resolve(url).server_argument, url)
        finally:
            stand_in.shutdown()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed = f"http://127.0.0.1:{probe.getsockname()[1]}"
        dead = narration.resolve(closed)
        self.assertEqual(dead.server_argument, "off")
        self.assertIn("not answering", dead.reason)
        self.assertEqual(narration.resolve("https://example.com").server_argument, "off")
        self.assertEqual(narration.resolve("nonsense").server_argument, "off")

    def test_flag_overrides_configuration(self):
        workspace = Workspace()
        try:
            config = configuration.load(workspace.paths)
            config["narration"] = {"mode": "off"}
            configuration.save(config, workspace.paths)
            self.assertEqual(narration.requested_mode(workspace.paths), "off")
            with mock.patch.dict(os.environ, {narration.ENV: "fm"}):
                self.assertEqual(narration.requested_mode(workspace.paths), "fm")
        finally:
            workspace.cleanup()


class Telling(WithFm):
    def test_fallback_is_announced_as_a_warning_with_the_reason(self):
        reporter = Recorder()
        narration.announce(narration.resolve("auto"), reporter)
        [(level, text, detail)] = reporter.messages
        self.assertIs(level, Level.WARNING)
        self.assertIn("using the default wording", text)
        self.assertIn("fm command was not found", detail)

    def test_an_available_model_is_announced(self):
        fake_fm(self.bin)
        reporter = Recorder()
        narration.announce(narration.resolve("auto"), reporter)
        self.assertEqual(reporter.messages[0][0], Level.INFO)
        self.assertIn("Apple Foundation Models", reporter.messages[0][1])

    def test_off_is_quiet(self):
        reporter = Recorder()
        narration.announce(narration.resolve("off"), reporter)
        self.assertEqual(reporter.messages, [])

    def test_server_reports_are_described(self):
        self.assertEqual(narration.describe_server(None)[0], "unknown")
        self.assertEqual(narration.describe_server({"enabled": False})[0], "off")
        state, text = narration.describe_server({"enabled": True, "state": "unavailable", "last_error": "the model is not reachable",
                                                 "backend": {"kind": "apple-foundation-models"}})
        self.assertEqual(state, "unavailable")
        self.assertIn("default wording", text)

    def test_server_is_told_to_keep_the_default_wording(self):
        workspace = Workspace()
        commands: list[list[str]] = []

        def record(command, **_):
            commands.append(command)
            raise OSError("not starting a real server")

        try:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            with mock.patch.dict(os.environ, {"DSTNS_API_PORT": str(port), "DSTNS_LOGS_DIR": str(workspace.root / "logs")}), \
                    mock.patch.object(server.subprocess, "Popen", side_effect=record):
                reporter = Recorder()
                with self.assertRaises(SimulationStartError):
                    server.start(reporter, workspace.paths, build_first=False)
            self.assertEqual(commands[0][-2:], ["--narrator", "off"])
            self.assertTrue(any(level is Level.WARNING and "default wording" in text for level, text, _ in reporter.messages))
        finally:
            workspace.cleanup()

    def test_environment_check_warns_without_failing(self):
        workspace = Workspace()
        try:
            [check] = [c for c in environment.checks(workspace.paths) if c.key == "narration"]
            environment.run_checks([check])
            self.assertIs(check.outcome.state, environment.State.WARNING)
            self.assertFalse(check.required)
            self.assertIn("default wording", check.outcome.value)
        finally:
            workspace.cleanup()


class CommandLine(unittest.TestCase):
    def test_flag_sets_the_mode_and_rejects_nonsense(self):
        with mock.patch.dict(os.environ, {}):
            cli.parse(["start", "--narrator", "off"])
            self.assertEqual(os.environ[narration.ENV], "off")
            cli.parse(["--narrator=http://127.0.0.1:11434"])
            self.assertEqual(os.environ[narration.ENV], "http://127.0.0.1:11434")
        with self.assertRaises(ConfigurationError):
            cli.parse(["--narrator", "chatgpt"])
        with self.assertRaises(ConfigurationError):
            cli.parse(["--narrator"])

    def test_its_value_is_not_mistaken_for_a_command(self):
        with mock.patch.object(sys.stdin, "isatty", return_value=True), mock.patch.object(sys.stdout, "isatty", return_value=True), \
                mock.patch.dict(os.environ, {"TERM": "xterm-256color"}):
            self.assertTrue(bootstrap.wants_interface(["--narrator", "off"]))

    def test_configuration_field(self):
        [field] = [f for f in configuration.FIELDS if f.key == "narration.mode"]
        self.assertEqual(configuration.check_field(field, "fm", {}), "")
        self.assertNotEqual(configuration.check_field(field, "gpt", {}), "")


class SyncedFolders(unittest.TestCase):
    def test_synced_folders_are_recognised(self):
        self.assertTrue(cloud_synced(Path("/Users/a/Library/CloudStorage/OneDrive-Personal/dstns")))
        self.assertTrue(cloud_synced(Path("/Users/a/Dropbox/dstns")))
        self.assertFalse(cloud_synced(Path("/Users/a/src/dstns")))
        self.assertFalse(cloud_synced(Path("/Users/a/Boxing/dstns")))

    def test_launcher_log_moves_to_local_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            synced = Path(tmp) / "OneDrive-Personal" / "dstns"
            with mock.patch.dict(os.environ, {"DSTNS_LOGS_DIR": str(synced / "logs")}):
                self.assertEqual(Paths(synced).launcher_log, local_state_dir() / "launcher.log")
            with mock.patch.dict(os.environ, {"DSTNS_LOGS_DIR": str(Path(tmp) / "logs")}):
                self.assertEqual(Paths(synced).launcher_log, Path(tmp).resolve() / "logs" / "launcher.log")

    def test_a_log_that_times_out_goes_quiet(self):
        class Evicted(io.StringIO):
            def write(self, _):
                raise TimeoutError(60, "Operation timed out")

        with tempfile.TemporaryDirectory() as tmp:
            handler = logsetup.QuietFileHandler(Path(tmp) / "launcher.log", delay=True)
            handler.stream = Evicted()
            logger = logging.getLogger("dstns.quiet-test")
            logger.addHandler(handler)
            logger.propagate = False
            errors = io.StringIO()
            with redirect_stderr(errors):
                for _ in range(3):
                    logger.warning("line")
            logger.removeHandler(handler)
            self.assertTrue(handler.failed)
            self.assertEqual(errors.getvalue(), "", "no traceback reaches the terminal")


if __name__ == "__main__":
    unittest.main()
