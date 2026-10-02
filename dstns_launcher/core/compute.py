# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""GPU acceleration: the ``compute`` settings, the server's environment, and the GPU probe.

The server chooses its compute backend itself (``auto``, ``cpu`` or ``vulkan``);
the launcher's part is to pass the configured choice on, and to find out,
before a run, what the machine can do. That finding-out is a real test: the
server brings each Vulkan device up, compiles its pipelines, dispatches a
kernel and checks the answer. The result is cached against everything that
could change it, so an ordinary launch costs nothing.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .paths import PATHS, Paths

BACKENDS = ("auto", "cpu", "vulkan")

#: config key -> (environment variable, how to write the value)
ENVIRONMENT = {
    "backend": "DSTNS_COMPUTE_BACKEND",
    "allow_vulkan": "DSTNS_ALLOW_VULKAN",
    "allow_software_vulkan": "DSTNS_ALLOW_SOFTWARE_VULKAN",
    "require_vulkan": "DSTNS_REQUIRE_VULKAN",
    "verification": "DSTNS_COMPUTE_VERIFY",
    "validation_layers": "DSTNS_VULKAN_VALIDATION",
    "device": "DSTNS_GPU_DEVICE",
    "gpu_thresholds.min_nodes": "DSTNS_COMPUTE_MIN_NODES",
    "gpu_thresholds.min_edges": "DSTNS_COMPUTE_MIN_EDGES",
}

DEFAULTS: dict[str, Any] = {
    "backend": "auto",
    "allow_vulkan": True,
    "allow_software_vulkan": False,
    "require_vulkan": False,
    "verification": False,
    "validation_layers": False,
    "device": "auto",
    "gpu_thresholds": {"min_nodes": 40000, "min_edges": 150000},
}

PROBE_TIMEOUT = 60.0


def settings(config: dict[str, Any]) -> dict[str, Any]:
    """The ``compute`` section with defaults filled in."""
    section = dict(DEFAULTS)
    section.update({k: v for k, v in (config.get("compute") or {}).items() if k != "gpu_thresholds"})
    section["gpu_thresholds"] = {**DEFAULTS["gpu_thresholds"], **((config.get("compute") or {}).get("gpu_thresholds") or {})}
    return section


def _lookup(section: dict[str, Any], key: str) -> Any:
    node: Any = section
    for part in key.split("."):
        node = node[part]
    return node


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)


def server_environment(config: dict[str, Any], environ: dict[str, str] | None = None) -> dict[str, str]:
    """Environment variables that carry the configured compute settings to the server.

    A variable the operator has already set is left alone: an explicit
    ``DSTNS_COMPUTE_BACKEND=cpu ./launcher`` beats the configuration file.
    """
    environ = dict(os.environ if environ is None else environ)
    section = settings(config)
    extra: dict[str, str] = {}
    for key, name in ENVIRONMENT.items():
        if environ.get(name):
            continue
        extra[name] = _text(_lookup(section, key))
    if not section["allow_vulkan"] and not environ.get("DSTNS_COMPUTE_BACKEND"):
        extra["DSTNS_COMPUTE_BACKEND"] = "cpu"
    return extra


def policy(config: dict[str, Any], environ: dict[str, str] | None = None) -> str:
    """What the server will do with GPUs, in one sentence."""
    environ = dict(os.environ if environ is None else environ)
    section = settings(config)
    backend = environ.get("DSTNS_COMPUTE_BACKEND") or ("cpu" if not section["allow_vulkan"] else section["backend"])
    source = " (DSTNS_COMPUTE_BACKEND)" if environ.get("DSTNS_COMPUTE_BACKEND") else ""
    if backend == "cpu":
        return f"CPU only{source}"
    if backend == "vulkan":
        strict = " — refuses to start without it" if section["require_vulkan"] else ", CPU if it cannot run"
        return f"Vulkan for every world{strict}{source}"
    limits = section["gpu_thresholds"]
    return (f"auto: CPU below {limits['min_nodes']:,} nodes and {limits['min_edges']:,} edges; "
            f"above, whichever is measured faster{source}")


# --- The probe -----------------------------------------------------------------


@dataclass
class Device:
    index: int
    name: str
    driver: str
    type: str
    api: str
    usable: bool
    reason: str
    software: bool
    moltenvk: bool
    selected: bool
    self_test: bool | None
    error: str = ""
    memory_bytes: int = 0
    workgroup: int = 0


@dataclass
class Probe:
    """What ``dstns_server --gpu-diagnostics`` found."""

    ran: bool
    compiled: bool = False
    available: bool = False
    reason: str = ""
    loader: str = ""
    instance_version: str = ""
    devices: list[Device] = field(default_factory=list)
    shader_bundle: str = ""
    seconds: float = 0.0
    cached: bool = False

    @property
    def selected(self) -> Device | None:
        return next((d for d in self.devices if d.selected), None)

    def headline(self) -> str:
        device = self.selected
        if not self.ran:
            return self.reason or "not tested"
        if not self.compiled:
            return "not built into this binary"
        if self.available and device:
            path = "MoltenVK → Metal" if device.moltenvk else device.driver
            return f"{device.name} · {path} · Vulkan {device.api}"
        return self.reason or "no usable device"


def parse(report: dict[str, Any]) -> Probe:
    devices = []
    for d in report.get("devices") or []:
        test = d.get("self_test")
        devices.append(Device(
            index=int(d.get("index", 0)), name=str(d.get("name", "?")), driver=str(d.get("driver", "")),
            type=str(d.get("type", "")), api=str(d.get("api_version", "")), usable=bool(d.get("usable")),
            reason=str(d.get("unusable_reason", "")), software=bool(d.get("software")), moltenvk=bool(d.get("moltenvk")),
            selected=bool(d.get("selected")), self_test=None if test is None else bool(test.get("passed")),
            error=str((test or {}).get("error", "")), memory_bytes=int(d.get("memory_bytes") or 0),
            workgroup=int((test or {}).get("workgroup_size") or 0)))
    loader = report.get("loader") or {}
    return Probe(ran=True, compiled=bool(report.get("compiled")), available=bool(report.get("available")),
                 reason=str(report.get("reason") or ""), loader=str(loader.get("library") or ""),
                 instance_version=str(loader.get("instance_version") or ""), devices=devices,
                 shader_bundle=str((report.get("shader_bundle") or {}).get("sha256") or ""))


def _icd_signature() -> list[str]:
    """Driver manifests whose change means the probe must run again."""
    places = [Path("/usr/share/vulkan/icd.d"), Path("/etc/vulkan/icd.d"), Path("/usr/local/share/vulkan/icd.d"),
              Path("/usr/local/etc/vulkan/icd.d"), Path("/opt/homebrew/share/vulkan/icd.d"), Path("/opt/homebrew/etc/vulkan/icd.d"),
              Path.home() / ".local/share/vulkan/icd.d"]
    signature = []
    for place in places:
        try:
            for entry in sorted(place.iterdir()):
                stat = entry.stat()
                signature.append(f"{entry}:{stat.st_size}:{int(stat.st_mtime)}")
        except OSError:
            continue
    for name in ("libvulkan.1.dylib", "libMoltenVK.dylib", "libvulkan.so.1"):
        for prefix in ("/opt/homebrew/lib", "/usr/local/lib", "/usr/lib", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu"):
            path = Path(prefix) / name
            if path.exists():
                signature.append(f"{path}:{path.stat().st_size}")
    return signature


def fingerprint(paths: Paths, config: dict[str, Any], environ: dict[str, str] | None = None) -> str:
    environ = dict(os.environ if environ is None else environ)
    stat = paths.server.stat()
    material = {
        "server": [stat.st_size, int(stat.st_mtime)],
        "settings": settings(config),
        "environment": {k: v for k, v in sorted(environ.items()) if k.startswith(("DSTNS_GPU", "DSTNS_VULKAN", "DSTNS_ALLOW",
                                                                                   "VK_", "DSTNS_COMPUTE"))},
        "drivers": _icd_signature(),
        "platform": [platform.system(), platform.release(), platform.machine()],
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()


def cache_path(paths: Paths) -> Path:
    return paths.root / "data" / "cache" / "compute-probe.json"


def probe(paths: Paths = PATHS, config: dict[str, Any] | None = None, *, refresh: bool = False,
          environ: dict[str, str] | None = None) -> Probe:
    """Test the GPUs for real, or return the cached result of the last identical test."""
    if not paths.server.exists():
        return Probe(ran=False, reason="the simulation core is not built yet")
    if config is None:
        from . import configuration

        config = configuration.load(paths)
    key = fingerprint(paths, config, environ)
    cache = cache_path(paths)
    if not refresh:
        try:
            stored = json.loads(cache.read_text(encoding="utf-8"))
            if stored.get("fingerprint") == key:
                result = parse(stored["report"])
                result.cached = True
                result.seconds = float(stored.get("seconds", 0))
                return result
        except (OSError, ValueError, KeyError, TypeError):
            pass
    env = {**(os.environ if environ is None else environ), **server_environment(config, environ)}
    started = time.monotonic()
    try:
        completed = subprocess.run([str(paths.server), "--gpu-diagnostics"], cwd=paths.root, capture_output=True, text=True,
                                   timeout=PROBE_TIMEOUT, stdin=subprocess.DEVNULL, env=env, errors="replace")
    except subprocess.TimeoutExpired:
        return Probe(ran=False, reason=f"the GPU test did not finish within {PROBE_TIMEOUT:g} s")
    except OSError as exc:
        return Probe(ran=False, reason=f"the simulation core could not be run: {exc}")
    seconds = time.monotonic() - started
    try:
        report = json.loads(completed.stdout)
    except ValueError:
        tail = (completed.stderr or completed.stdout).strip().splitlines()[-1:] or ["no output"]
        return Probe(ran=False, reason=f"the GPU test failed ({tail[0][:160]})")
    result = parse(report)
    result.seconds = seconds
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"fingerprint": key, "seconds": seconds, "report": report}, indent=1), encoding="utf-8")
    except OSError:
        pass
    return result


def remedy(result: Probe) -> str:
    """What the operator can do about a missing GPU path on this platform."""
    if result.available:
        return ""
    if not result.compiled and result.ran:
        return "Rebuild with -DDSTNS_ENABLE_VULKAN=ON (the default); see Building from source."
    software_only = result.devices and all(d.software for d in result.devices if d.usable)
    if sys.platform == "darwin":
        if not result.loader:
            return "Install MoltenVK and the Vulkan loader: brew install molten-vk vulkan-loader (or ./launcher bootstrap)."
        return "Apple GPUs need MoltenVK 1.2 or later: brew upgrade molten-vk."
    if os.environ.get("WSL_DISTRO_NAME") or "microsoft" in platform.release().lower():
        return ("WSL 2 reaches the GPU through Mesa's D3D12 Vulkan driver: update Windows' GPU driver and install "
                "mesa-vulkan-drivers in the distribution. Without it the CPU backend is used.")
    if not result.loader:
        return "Install the Vulkan loader (libvulkan1, vulkan-loader or vulkan-icd-loader); ./launcher bootstrap does it."
    if software_only or not result.devices:
        return ("No hardware Vulkan driver is installed. AMD and Intel: install Mesa's Vulkan drivers (mesa-vulkan-drivers / "
                "vulkan-radeon / vulkan-intel). NVIDIA: the proprietary driver includes Vulkan. Driver installation is "
                "left to you; DSTNS runs on the CPU meanwhile.")
    return "See Troubleshooting → GPU acceleration in the documentation."
