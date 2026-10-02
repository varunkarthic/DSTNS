# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""GPU acceleration and machine preparation in the launcher, tested without a GPU."""
from __future__ import annotations

import json
import os
import stat
import sys
import textwrap
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fakes import Workspace  # noqa: E402

from dstns_launcher import cli  # noqa: E402
from dstns_launcher.core import compute, configuration, dependencies, environment  # noqa: E402
from dstns_launcher.core.environment import State  # noqa: E402
from dstns_launcher.core.errors import ConfigurationError  # noqa: E402

REPORT = {
    "compiled": True, "available": True,
    "loader": {"loaded": True, "library": "libvulkan.1.dylib", "instance_version": "1.3.0"},
    "selected": {"index": 1, "name": "Test GPU"},
    "shader_bundle": {"sha256": "ab" * 32},
    "devices": [
        {"index": 0, "name": "llvmpipe", "driver": "llvmpipe", "type": "cpu", "api_version": "1.4.0", "usable": True,
         "software": True, "moltenvk": False, "selected": False, "self_test": {"passed": True, "workgroup_size": 128}},
        {"index": 1, "name": "Test GPU", "driver": "MoltenVK", "type": "integrated", "api_version": "1.3.0", "usable": True,
         "software": False, "moltenvk": True, "selected": True, "memory_bytes": 1 << 34,
         "self_test": {"passed": True, "workgroup_size": 128}},
    ],
}


class WithWorkspace(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Workspace()
        self.paths = self.workspace.paths
        self.env = mock.patch.dict(os.environ, {"DSTNS_LOGS_DIR": str(self.workspace.root / "logs")})
        self.env.start()
        for name in list(os.environ):
            if name.startswith(("DSTNS_COMPUTE", "DSTNS_GPU", "DSTNS_VULKAN", "DSTNS_ALLOW", "DSTNS_REQUIRE")):
                os.environ.pop(name)

    def tearDown(self) -> None:
        self.env.stop()
        self.workspace.cleanup()

    def fake_server(self, report: dict, *, code: int = 0) -> Path:
        """A stand-in dstns_server that prints a diagnostics report and counts its runs."""
        server = self.paths.server
        server.parent.mkdir(parents=True, exist_ok=True)
        counter = self.workspace.root / "probe-runs"
        server.write_text(textwrap.dedent(f"""\
            #!{sys.executable}
            import sys
            assert sys.argv[1:] == ["--gpu-diagnostics"], sys.argv
            with open({str(counter)!r}, "a") as f:
                f.write("x")
            print({json.dumps(json.dumps(report))})
            sys.exit({code})
            """))
        server.chmod(server.stat().st_mode | stat.S_IXUSR)
        return counter


class Configuration(WithWorkspace):
    def test_the_shipped_defaults_carry_a_valid_compute_section(self):
        config = configuration.load(self.paths)
        self.assertEqual(config["compute"]["backend"], "auto")
        self.assertEqual(compute.settings(config)["gpu_thresholds"], {"min_nodes": 40000, "min_edges": 150000})

    def test_invalid_compute_values_are_refused(self):
        config = configuration.load(self.paths)
        for key, value in (("backend", "cuda"), ("allow_vulkan", "yes"), ("device", ""), ("device", "x" * 300)):
            broken = json.loads(json.dumps(config))
            broken["compute"][key] = value
            with self.assertRaises(ConfigurationError):
                configuration.validate(broken)
        broken = json.loads(json.dumps(config))
        broken["compute"]["gpu_thresholds"]["min_edges"] = -1
        with self.assertRaises(ConfigurationError):
            configuration.validate(broken)

    def test_the_editor_offers_the_compute_settings(self):
        fields = {f.key: f for f in configuration.FIELDS}
        self.assertIn("Compute", configuration.CATEGORIES)
        self.assertEqual(fields["compute.backend"].parse("vulkan"), "vulkan")
        with self.assertRaises(ConfigurationError):
            fields["compute.backend"].parse("metal")
        self.assertIs(fields["compute.allow_vulkan"].parse("off"), False)
        config = configuration.load(self.paths)
        fields["compute.backend"].set(config, "cpu")
        configuration.save(config, self.paths)
        self.assertEqual(configuration.load(self.paths)["compute"]["backend"], "cpu")


class ServerEnvironment(WithWorkspace):
    def test_configuration_reaches_the_server_as_environment(self):
        config = configuration.load(self.paths)
        config["compute"].update(backend="vulkan", require_vulkan=True, device="Radeon")
        env = compute.server_environment(config, {})
        self.assertEqual((env["DSTNS_COMPUTE_BACKEND"], env["DSTNS_REQUIRE_VULKAN"], env["DSTNS_GPU_DEVICE"]), ("vulkan", "1", "Radeon"))
        self.assertEqual(env["DSTNS_COMPUTE_MIN_EDGES"], "150000")

    def test_the_operators_own_environment_wins(self):
        config = configuration.load(self.paths)
        config["compute"]["backend"] = "vulkan"
        env = compute.server_environment(config, {"DSTNS_COMPUTE_BACKEND": "cpu"})
        self.assertNotIn("DSTNS_COMPUTE_BACKEND", env)
        self.assertIn("(DSTNS_COMPUTE_BACKEND)", compute.policy(config, {"DSTNS_COMPUTE_BACKEND": "cpu"}))

    def test_switching_gpu_acceleration_off_means_cpu(self):
        config = configuration.load(self.paths)
        config["compute"]["allow_vulkan"] = False
        self.assertEqual(compute.server_environment(config, {})["DSTNS_COMPUTE_BACKEND"], "cpu")
        self.assertEqual(compute.policy(config, {}), "CPU only")

    def test_cli_compute_options_are_validated_and_exported(self):
        args = cli.parse(["start", "--compute", "vulkan", "--gpu-device", "1"])
        self.assertEqual((args.compute, args.gpu_device), ("vulkan", "1"))
        for bad in (["--compute", "cuda"], ["--profile", "huge"], ["--compute"]):
            with self.assertRaises(ConfigurationError):
                cli.parse(["start", *bad])


class Probe(WithWorkspace):
    def test_a_real_report_is_parsed(self):
        result = compute.parse(REPORT)
        self.assertTrue(result.available)
        self.assertEqual(result.selected.name, "Test GPU")
        self.assertEqual(result.headline(), "Test GPU · MoltenVK → Metal · Vulkan 1.3.0")
        self.assertTrue(result.devices[0].software)

    def test_the_probe_runs_once_and_is_then_cached(self):
        counter = self.fake_server(REPORT)
        config = configuration.load(self.paths)
        first = compute.probe(self.paths, config, environ={})
        second = compute.probe(self.paths, config, environ={})
        self.assertTrue(first.available and not first.cached)
        self.assertTrue(second.available and second.cached)
        self.assertEqual(counter.read_text(), "x")
        # A change of setting invalidates the cache.
        config["compute"]["device"] = "0"
        compute.probe(self.paths, config, environ={})
        self.assertEqual(counter.read_text(), "xx")
        compute.probe(self.paths, config, refresh=True, environ={})
        self.assertEqual(counter.read_text(), "xxx")

    def test_a_broken_core_is_reported_not_raised(self):
        self.paths.server.parent.mkdir(parents=True, exist_ok=True)
        self.paths.server.write_text(f"#!{sys.executable}\nimport sys\nprint('Segmentation fault', file=sys.stderr)\nsys.exit(139)\n")
        self.paths.server.chmod(0o755)
        result = compute.probe(self.paths, configuration.load(self.paths), environ={})
        self.assertFalse(result.ran)
        self.assertIn("Segmentation fault", result.reason)

    def test_no_gpu_is_not_fatal_in_auto_mode(self):
        self.fake_server({**REPORT, "available": False, "devices": [], "reason": "no devices"}, code=3)
        check = next(c for c in environment.checks(self.paths) if c.key == "vulkan")
        environment.run_checks([check])
        self.assertEqual(check.outcome.state, State.SKIPPED)
        self.assertFalse(check.required)
        self.assertIn("runs on the CPU", check.outcome.detail)

    def test_a_required_gpu_that_is_missing_blocks_a_run(self):
        self.fake_server({**REPORT, "available": False, "devices": [], "reason": "no devices"}, code=3)
        config = configuration.load(self.paths)
        config["compute"].update(backend="vulkan", require_vulkan=True)
        configuration.save(config, self.paths)
        check = next(c for c in environment.checks(self.paths) if c.key == "vulkan")
        environment.run_checks([check])
        self.assertEqual(check.outcome.state, State.FAIL)
        self.assertTrue(check.required)
        self.assertEqual(environment.blocking([check]), [check])


class Dependencies(unittest.TestCase):
    @staticmethod
    def linux(distribution: str, manager_tool: str, like: str = "") -> dependencies.Platform:
        return dependencies.detect_platform(release={"ID": distribution, "ID_LIKE": like}, system="linux",
                                            which=lambda tool: f"/usr/bin/{tool}" if tool == manager_tool else None)

    @staticmethod
    def nothing_installed(target: dependencies.Platform) -> list[dependencies.Status]:
        return [dependencies.Status(d, None) for d in dependencies.MANIFEST if target.system in d.platforms]

    def test_distributions_map_to_their_package_manager(self):
        self.assertEqual(self.linux("ubuntu", "apt-get", "debian").manager, "apt")
        self.assertEqual(self.linux("pop", "apt-get", "ubuntu debian").manager, "apt")
        self.assertEqual(self.linux("fedora", "dnf").manager, "dnf")
        self.assertEqual(self.linux("arch", "pacman").manager, "pacman")
        self.assertEqual(dependencies.detect_platform(system="darwin", which=lambda t: "/opt/homebrew/bin/brew").manager, "brew")

    def test_one_install_command_with_one_sudo(self):
        target = self.linux("ubuntu", "apt-get", "debian")
        plan = dependencies.plan(target, "full", assume_yes=True, statuses=self.nothing_installed(target))
        self.assertEqual(plan.commands[0], ["sudo", "apt-get", "update"])
        install = plan.commands[-1]
        self.assertEqual(install[:5], ["sudo", "apt-get", "install", "--no-install-recommends", "-y"])
        self.assertIn("libvulkan1", install)
        self.assertIn("sumo", install)
        self.assertEqual(len(plan.commands), 2)

    def test_every_command_is_an_argument_list_from_the_manifest(self):
        allowed = {p for d in dependencies.MANIFEST for names in d.packages.values() for p in names}
        for target in (self.linux("ubuntu", "apt-get", "debian"), self.linux("fedora", "dnf"), self.linux("arch", "pacman"),
                       dependencies.detect_platform(system="darwin", which=lambda t: "/opt/homebrew/bin/brew")):
            plan = dependencies.plan(target, "full", statuses=self.nothing_installed(target))
            for command in plan.commands:
                self.assertIsInstance(command, list)
                for part in command:
                    self.assertNotRegex(part, r"[;&|`$<>]")
                packages = [p for p in command if p in allowed]
                self.assertTrue(packages or "update" in command or "tap" in command, command)

    def test_gpu_drivers_are_never_planned(self):
        drivers = ("nvidia", "mesa-vulkan-drivers", "vulkan-radeon", "vulkan-intel", "amdgpu", "xserver-xorg-video")
        for target in (self.linux("ubuntu", "apt-get", "debian"), self.linux("fedora", "dnf"), self.linux("arch", "pacman")):
            plan = dependencies.plan(target, "full", statuses=self.nothing_installed(target))
            for package in plan.packages:
                self.assertFalse(package.startswith(drivers), package)
            self.assertTrue(any("never installed" in note for note in plan.notes))

    def test_what_cannot_be_installed_is_explained(self):
        target = self.linux("arch", "pacman")
        plan = dependencies.plan(target, "full", statuses=self.nothing_installed(target))
        self.assertIn("Eclipse SUMO", [name for name, _ in plan.manual])
        mac = dependencies.detect_platform(system="darwin", which=lambda tool: None)
        plan = dependencies.plan(mac, "minimal", statuses=self.nothing_installed(mac))
        self.assertFalse(plan.commands)
        self.assertTrue(any("Homebrew is not installed" in note for note in plan.notes))

    def test_a_satisfied_machine_needs_nothing(self):
        target = self.linux("ubuntu", "apt-get", "debian")
        statuses = [dependencies.Status(d, "present") for d in dependencies.MANIFEST if "linux" in d.platforms]
        plan = dependencies.plan(target, "full", statuses=statuses)
        self.assertFalse(plan.needed)
        self.assertEqual(plan.missing, [])

    def test_homebrew_taps_the_dlr_formula_and_never_uses_sudo(self):
        mac = dependencies.detect_platform(system="darwin", which=lambda t: "/opt/homebrew/bin/brew")
        plan = dependencies.plan(mac, "full", statuses=self.nothing_installed(mac))
        self.assertEqual(plan.commands[0], ["brew", "tap", "dlr-ts/sumo"])
        self.assertTrue(all(command[0] == "brew" for command in plan.commands))
        self.assertIn("molten-vk", plan.packages)

    def test_bootstrap_check_lists_the_plan_and_installs_nothing(self):
        target = self.linux("ubuntu", "apt-get", "debian")
        statuses = self.nothing_installed(target)
        with mock.patch.object(dependencies, "detect_platform", return_value=target), \
                mock.patch.object(dependencies, "survey", return_value=statuses), \
                mock.patch.object(dependencies.subprocess, "run") as run:
            code = cli.main(["bootstrap", "--check", "--no-color"])
        self.assertEqual(code, cli.EXIT_FAILURE)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=1)
