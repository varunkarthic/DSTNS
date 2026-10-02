# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Launcher operations, tested without any interface."""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fakes import ROOT, FakeServer, Workspace  # noqa: E402

from dstns_launcher.core import api, artifacts, configuration, environment, server, simulation, terminal, version  # noqa: E402
from dstns_launcher.core.configuration import RunOptions  # noqa: E402
from dstns_launcher.core.environment import Check, Outcome, State  # noqa: E402
from dstns_launcher.core.errors import ConfigurationError, SimulationStartError  # noqa: E402
from dstns_launcher.core.reporting import Reporter  # noqa: E402


class WithWorkspace(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Workspace()
        self.paths = self.workspace.paths
        self.env = mock.patch.dict(os.environ, {"DSTNS_LOGS_DIR": str(self.workspace.root / "logs"),
                                                "DSTNS_SEED_DB": str(self.workspace.root / "seeds.sqlite3")})
        self.env.start()
        os.environ.pop("DSTNS_API_PORT", None)
        os.environ.pop("DSTNS_OPERATOR_TOKEN", None)

    def tearDown(self) -> None:
        self.env.stop()
        self.workspace.cleanup()


class Configuration(WithWorkspace):
    def test_loads_and_validates_the_real_defaults(self):
        config = configuration.load(self.paths)
        self.assertEqual(config["api"]["port"], 8090)

    def test_invalid_values_are_refused_with_the_engine_bounds(self):
        config = configuration.load(self.paths)
        for key, value, message in (("duration_seconds", 59, "duration_seconds"), ("tick_rate", 5.5, "tick_rate"),
                                    ("tick_rate", 0, "tick_rate")):
            broken = json.loads(json.dumps(config))
            broken["playback"][key] = value
            with self.assertRaisesRegex(ConfigurationError, message):
                configuration.validate(broken)

    def test_missing_and_malformed_files_explain_the_remedy(self):
        self.paths.config.write_text("{ not json")
        with self.assertRaises(ConfigurationError) as caught:
            configuration.load(self.paths)
        self.assertIn("not valid JSON", str(caught.exception))
        self.assertIn("git checkout", caught.exception.remedy)
        self.paths.config.unlink()
        with self.assertRaisesRegex(ConfigurationError, "missing"):
            configuration.load(self.paths)

    def test_fields_parse_and_reject_without_coercion(self):
        fields = {field.key: field for field in configuration.FIELDS}
        duration = fields["playback.duration_seconds"]
        self.assertEqual(duration.parse("600"), 600)
        for bad in ("-10", "10", "3601", "1.5", "abc"):
            with self.assertRaises(ConfigurationError):
                duration.parse(bad)
        speed = fields["playback.tick_rate"]
        self.assertEqual(speed.parse("2.5"), 2.5)
        with self.assertRaisesRegex(ConfigurationError, "greater than 0"):
            speed.parse("0")
        self.assertIs(fields["modules.dws"].parse("off"), False)
        self.assertEqual(fields["day"].parse("weekend"), 1)

    def test_storm_spacing_is_checked_against_the_day(self):
        config = configuration.load(self.paths)
        storms = next(field for field in configuration.FIELDS if field.key == "dws.frequency")
        config["playback"]["duration_seconds"] = 60
        self.assertTrue(configuration.check_field(storms, 13, config))
        self.assertEqual(configuration.check_field(storms, 12, config), "")

    def test_save_keeps_the_file_format_and_round_trips(self):
        original = self.paths.config.read_text()
        config = configuration.load(self.paths)
        configuration.save(config, self.paths)
        self.assertEqual(self.paths.config.read_text(), original)
        config["playback"]["duration_seconds"] = 900
        configuration.save(config, self.paths)
        self.assertEqual(configuration.load(self.paths)["playback"]["duration_seconds"], 900)

    def test_save_refuses_invalid_configuration_and_leaves_the_file(self):
        original = self.paths.config.read_text()
        config = configuration.load(self.paths)
        config["api"]["port"] = 70000
        with self.assertRaises(ConfigurationError):
            configuration.save(config, self.paths)
        self.assertEqual(self.paths.config.read_text(), original)


class StartRequest(WithWorkspace):
    def test_seed_is_normalised_to_decimal(self):
        request = configuration.start_request(RunOptions(seed="0x5d7cb"), paths=self.paths)
        self.assertEqual(request["seed"], "382923")
        self.assertEqual(request["map"]["osm_file"], "auto")
        self.assertEqual(request["map_selection_version"], "urban-crfg-v3")

    def test_fresh_seed_is_64_bits(self):
        seed = int(configuration.start_request(RunOptions(), paths=self.paths)["seed"])
        self.assertLess(seed, 1 << 64)

    def test_options_override_defaults(self):
        request = configuration.start_request(RunOptions(day_type="weekend", speed="2", duration="600", max_nodes="2000",
                                                         osm_file="data/fixtures/roads.osm.xml"), paths=self.paths)
        self.assertEqual((request["day"], request["tick_rate"], request["playback_duration_seconds"],
                          request["map"]["max_nodes"]), (1, 2, 600, 2000))
        self.assertTrue(request["map"]["osm_file"].endswith("roads.osm.xml"))

    def test_messages_match_the_existing_cli(self):
        cases = [
            (RunOptions(seed="42", saved_seed="x"), "mutually exclusive"),
            (RunOptions(seed="-4"), "decimal integer"),
            (RunOptions(seed=str(1 << 128)), "128 bits"),
            (RunOptions(speed="nan"), "must be"),
            (RunOptions(speed="6"), r"--speed must be in"),
            (RunOptions(duration="9999"), r"--duration must be in"),
            (RunOptions(duration="90.5"), r"--duration must be in"),
            (RunOptions(day_type="holiday"), "weekday or weekend"),
            (RunOptions(osm_file="missing.osm.xml"), "OSM data unavailable"),
        ]
        for options, message in cases:
            with self.subTest(options=options), self.assertRaisesRegex(ConfigurationError, message):
                configuration.start_request(options, paths=self.paths)


class SavedSeeds(WithWorkspace):
    def test_save_use_and_delete_through_the_existing_store(self):
        from dstns_launcher.core import seeds

        request = configuration.start_request(RunOptions(seed="42"), paths=self.paths)
        saved = seeds.operate("save", {"id": "probe", "description": "", "config": request}, paths=self.paths)
        self.assertEqual(saved["map_sha256"], "auto")
        self.assertEqual(seeds.operate("use", {"id": "probe"}, paths=self.paths)["config"]["seed"], "42")
        replay = configuration.start_request(RunOptions(saved_seed="probe", day_type="weekend"), paths=self.paths)
        self.assertEqual((replay["seed"], replay["day"]), ("42", 1))
        seeds.operate("delete", {"id": "probe"}, paths=self.paths)
        with self.assertRaisesRegex(ConfigurationError, "Unknown saved seed"):
            seeds.operate("use", {"id": "probe"}, paths=self.paths)


class Version(unittest.TestCase):
    def test_version_comes_from_cmake(self):
        expected = re.search(r"project\(dstns VERSION ([0-9.]+)", (ROOT / "CMakeLists.txt").read_text()).group(1)
        self.assertEqual(version.engine_version(ROOT), expected)

    def test_unknown_when_unreadable(self):
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(version.engine_version(Path(empty)), "unknown")


class Fingerprints(unittest.TestCase):
    def test_outputs_rebuild_when_nested_sources_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src" / "components").mkdir(parents=True)
            output, stamp = root / "bundle", root / "stamp"
            output.write_text("old bundle")
            (root / "src" / "components" / "Map.tsx").write_text("old map")
            first = artifacts.needs_build(root, ["src"], output, stamp)
            self.assertTrue(first.needed)
            stamp.write_text(first.fingerprint)
            self.assertFalse(artifacts.needs_build(root, ["src"], output, stamp).needed)
            (root / "src" / "components" / "Map.tsx").write_text("new map")
            self.assertTrue(artifacts.needs_build(root, ["src"], output, stamp).needed)
            output.unlink()
            self.assertTrue(artifacts.needs_build(root, ["src"], output, stamp).needed)


class Checks(unittest.TestCase):
    def test_a_check_that_raises_is_reported_not_fatal(self):
        def broken():
            raise RuntimeError("boom")

        items = [Check("ok", "Fine", lambda: Outcome(State.PASS, "fine")), Check("bad", "Broken", broken)]
        environment.run_checks(items)
        self.assertEqual(items[0].outcome.state, State.PASS)
        self.assertEqual(items[1].outcome.state, State.FAIL)
        self.assertIn("boom", items[1].outcome.detail)
        self.assertEqual([check.key for check in environment.blocking(items)], ["bad"])

    def test_optional_failures_do_not_block(self):
        items = [Check("x", "Optional", lambda: Outcome(State.FAIL, "no"), required=False)]
        environment.run_checks(items)
        self.assertEqual(environment.blocking(items), [])

    def test_states_report_progress(self):
        seen = []
        items = [Check("x", "One", lambda: Outcome(State.WARNING, "meh"))]
        environment.run_checks(items, on_update=lambda check: seen.append(check.outcome.state))
        self.assertEqual(seen, [State.RUNNING, State.WARNING])

    def test_every_state_has_text_not_only_colour(self):
        for state, (fancy, plain, word) in environment.MARKERS.items():
            self.assertTrue(word and plain.isascii() and fancy, state)

    def test_real_checks_run_on_this_checkout(self):
        items = environment.run_checks(environment.checks())
        self.assertTrue(all(check.outcome.state is not State.PENDING for check in items))


class Terminal(unittest.TestCase):
    def test_breakpoints(self):
        cases = {(160, 45): "large", (120, 35): "large", (100, 30): "large", (80, 24): "medium", (70, 22): "medium",
                 (60, 18): "small", (50, 15): "small", (40, 12): "too-small", (99, 40): "medium", (120, 21): "small"}
        for (width, height), expected in cases.items():
            self.assertEqual(terminal.layout_for(width, height).value, expected, (width, height))

    def test_no_color_is_honoured(self):
        with mock.patch.dict(os.environ, {"NO_COLOR": "1"}):
            self.assertIs(terminal._colors(False, True, "xterm-256color"), terminal.Colors.NONE)
        with mock.patch.dict(os.environ, {"COLORTERM": "truecolor"}, clear=False):
            os.environ.pop("NO_COLOR", None)
            self.assertIs(terminal._colors(False, True, "xterm"), terminal.Colors.TRUECOLOR)
        self.assertIs(terminal._colors(True, True, "xterm"), terminal.Colors.NONE)
        self.assertIs(terminal._colors(False, False, "xterm"), terminal.Colors.NONE)


class Servers(WithWorkspace):
    def test_attaches_to_a_current_server(self):
        with FakeServer() as fake:
            os.environ["DSTNS_API_PORT"] = str(fake.port)
            handle = server.start(Reporter(), self.paths, build_first=False)
            self.assertEqual(handle.port, fake.port)
            self.assertFalse(handle.managed)
            self.assertEqual(json.loads(self.paths.active_server.read_text())["port"], fake.port)

    def test_an_older_server_is_left_alone(self):
        with FakeServer(current=False) as old:
            os.environ["DSTNS_API_PORT"] = str(old.port)
            # No real server binary here: starting one on another port must fail clearly.
            with self.assertRaises(SimulationStartError):
                server.start(Reporter(), self.paths, build_first=False)
            self.assertEqual(old.posted("/api/v1/playback/start"), [])

    def test_invalid_port_variable(self):
        os.environ["DSTNS_API_PORT"] = "70000"
        with self.assertRaisesRegex(ConfigurationError, "DSTNS_API_PORT"):
            server.configured_port(self.paths)

    def test_shutdown_requests_termination_and_waits(self):
        with FakeServer() as fake:
            handle = server.ServerHandle(fake.port, "127.0.0.1", {})
            self.assertTrue(server.shut_down(handle, wait=5))
            self.assertTrue(fake.terminated)


class Runs(WithWorkspace):
    def test_start_run_reports_the_world(self):
        with FakeServer() as fake:
            world = simulation.start_run(fake.port, {"seed": "42", "day": 1, "map": {"osm_file": "auto"}}, Reporter(), self.paths)
            self.assertEqual((world.place, world.nodes, world.day_name), ("Testville, Nowhere", 5, "weekend"))
            self.assertEqual(fake.posted("/api/v1/playback/start")[0]["seed"], "42")

    def test_map_failure_offers_recovery(self):
        with FakeServer(start_code=503) as fake:
            with self.assertRaises(SimulationStartError) as caught:
                simulation.start_run(fake.port, {"seed": "1", "map": {"osm_file": "auto"}}, Reporter(), self.paths)
            self.assertIn("could not fetch", str(caught.exception))
            self.assertIn("no other city is substituted", caught.exception.remedy)

    def test_preparation_error_is_reported(self):
        with FakeServer(preparation_error="district too small") as fake:
            with self.assertRaisesRegex(SimulationStartError, "district too small"):
                simulation.start_run(fake.port, {"seed": "1", "map": {"osm_file": "auto"}}, Reporter(), self.paths)

    def test_synthetic_topology_is_refused(self):
        with FakeServer(topology_source="synthetic") as fake:
            with self.assertRaisesRegex(SimulationStartError, "usable real OSM"):
                simulation.start_run(fake.port, {"seed": "1", "map": {"osm_file": "auto"}}, Reporter(), self.paths)

    def test_status_metrics_and_controls(self):
        with FakeServer(lifecycle_after_start="RUNNING") as fake:
            fake.lifecycle = "RUNNING"
            status = simulation.status(fake.port, self.paths)
            self.assertEqual((status.lifecycle, status.clock), ("RUNNING", "01:00:00"))
            figures = simulation.metrics(fake.port, self.paths)
            self.assertEqual((figures.vehicles, figures.congestion, figures.closed_roads), (10, 12.5, 1))
            self.assertAlmostEqual(simulation.remaining_wall_seconds(status, figures.target_rate), (86400 - 3600) / 24)
            simulation.control(fake.port, "pause", self.paths)
            self.assertEqual(simulation.status(fake.port, self.paths).lifecycle, "PAUSED")
            self.assertIsNone(simulation.remaining_wall_seconds(simulation.status(fake.port, self.paths), 24))

    def test_unreachable_server(self):
        self.assertFalse(simulation.status(1, self.paths).reachable)
        self.assertIsNone(api.health(1))


class Cancellation(unittest.TestCase):
    def test_timeout_stops_a_descendant_after_its_parent_exits(self):
        from dstns_launcher.core import process
        import subprocess

        script = ("import subprocess,sys; "
                  "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                  "print(p.pid,flush=True)")
        result = process.run([sys.executable, "-c", script], timeout=1.0, check=False)
        self.assertTrue(result.timed_out)
        self.assertEqual(result.code, 124)
        self.assertLess(result.seconds, 5)
        state = subprocess.run(["ps", "-p", result.output.strip(), "-o", "stat="],
                               capture_output=True, text=True).stdout.strip()
        self.assertTrue(not state or state.startswith("Z"), state)

    def test_cancellation_reaches_build_descendants_and_does_not_mark_build_complete(self):
        import subprocess
        import threading
        import time
        from dstns_launcher.core import build
        from dstns_launcher.core.errors import OperationCancelled

        cancel = threading.Event()
        pid = []
        class Capture(Reporter):
            def step_output(self, _title, line):
                if line.startswith("child="):
                    pid.append(int(line.split("=")[1]))
                    cancel.set()

        script = ("import subprocess,sys,time; "
                  "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                  "print('child='+str(p.pid),flush=True); time.sleep(60)")
        marked = mock.Mock()
        started = time.monotonic()
        with self.assertRaises(OperationCancelled):
            build.execute(build.BuildPlan([build.Step("Build", [sys.executable, "-c", script], after=marked)]),
                          Capture(), cancel=cancel)
        self.assertLess(time.monotonic() - started, 5)
        marked.assert_not_called()
        self.assertEqual(len(pid), 1)
        # An unreaped zombie has exited and is no longer executing code.
        state = subprocess.run(["ps", "-p", str(pid[0]), "-o", "stat="], capture_output=True, text=True).stdout.strip()
        self.assertTrue(not state or state.startswith("Z"), state)

    def test_interrupted_output_callback_stops_the_command(self):
        from dstns_launcher.core import process
        import subprocess

        pid = []
        def interrupt(line):
            pid.append(int(line))
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            process.run([sys.executable, "-c", "import os,time; print(os.getpid(),flush=True); time.sleep(60)"],
                        on_line=interrupt)
        result = subprocess.run(["ps", "-p", str(pid[0]), "-o", "stat="], capture_output=True, text=True)
        self.assertFalse(result.stdout.strip())

    def test_cleanup_cancels_pending_start_before_it_can_create_a_run(self):
        import threading
        from dstns_launcher.core.session import Session
        from dstns_launcher.core.errors import OperationCancelled
        from dstns_launcher.core.process import check_cancelled

        entered = threading.Event()
        errors = []
        session = Session()
        def blocked_start(_reporter, _paths, *, cancel):
            entered.set()
            cancel.wait(3)
            check_cancelled(cancel)
            raise AssertionError("cleanup must signal cancellation")
        def launch():
            try:
                session.launch(RunOptions(), Reporter())
            except OperationCancelled:
                pass
            except BaseException as exc:
                errors.append(exc)
        with mock.patch("dstns_launcher.core.session.simulation.prepare_request", return_value={}), \
                mock.patch("dstns_launcher.core.session.server.start", side_effect=blocked_start), \
                mock.patch("dstns_launcher.core.session.simulation.start_run") as start_run:
            worker = threading.Thread(target=launch)
            worker.start()
            self.assertTrue(entered.wait(2))
            session.cleanup()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
            self.assertFalse(errors, errors)
            start_run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
