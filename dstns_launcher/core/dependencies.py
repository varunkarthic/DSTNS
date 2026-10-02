# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Preparing a machine to run DSTNS: what it needs, what it has, and how to install the rest.

``./launcher bootstrap`` reads a fixed manifest of dependencies, detects which
are present (by running them or finding their headers, not by trusting a
package database), and builds one installation plan for the platform's package
manager. Nothing is installed without the operator's consent, ``sudo`` is asked
for once for the whole plan, and everything is checked again afterwards.

Deliberately never installed: GPU drivers (kernel modules, the NVIDIA driver,
Mesa on a system that already chose a driver) and Homebrew itself. Those change
the system in ways that need a person's judgement; the plan says what to do
instead. Package names come only from this file, and commands are argument
lists, never shell strings.
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .errors import DependencyError
from .paths import PATHS, Paths
from .reporting import Level, Reporter


# --- The platform ------------------------------------------------------------------


@dataclass(frozen=True)
class Platform:
    system: str          # "macos", "linux", "other"
    distribution: str    # "ubuntu", "debian", "fedora", "arch", ... ("" on macOS)
    manager: str         # "brew", "apt", "dnf", "pacman", ""
    machine: str
    wsl: bool = False
    container: bool = False

    def describe(self) -> str:
        parts = {"macos": f"macOS {platform.mac_ver()[0] or ''}".strip(), "linux": (self.distribution or "Linux").capitalize()}
        text = parts.get(self.system, platform.system())
        if self.wsl:
            text += " on WSL 2"
        if self.container:
            text += " in a container"
        return f"{text} / {self.machine}"


def _os_release(path: Path = Path("/etc/os-release")) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if key:
                values[key.strip()] = value.strip().strip('"')
    except OSError:
        pass
    return values


def detect_platform(*, release: dict[str, str] | None = None, system: str | None = None,
                    which: Callable[[str], str | None] = shutil.which) -> Platform:
    system = system or sys.platform
    machine = platform.machine() or "unknown"
    if system == "darwin":
        return Platform("macos", "", "brew" if which("brew") else "", machine)
    if not system.startswith("linux"):
        return Platform("other", "", "", machine)
    info = release if release is not None else _os_release()
    distribution = info.get("ID", "linux").lower()
    family = f"{distribution} {info.get('ID_LIKE', '').lower()}"
    if re.search(r"\b(debian|ubuntu)\b", family) and which("apt-get"):
        manager = "apt"
    elif re.search(r"\b(fedora|rhel|centos)\b", family) and which("dnf"):
        manager = "dnf"
    elif re.search(r"\barch\b", family) and which("pacman"):
        manager = "pacman"
    else:
        manager = next((m for m, tool in (("apt", "apt-get"), ("dnf", "dnf"), ("pacman", "pacman")) if which(tool)), "")
    try:
        wsl = "microsoft" in Path("/proc/version").read_text(encoding="utf-8").lower()
    except OSError:
        wsl = False
    container = Path("/.dockerenv").exists() or Path("/run/.containerenv").exists()
    return Platform("linux", distribution, manager, machine, wsl=wsl or bool(os.environ.get("WSL_DISTRO_NAME")), container=container)


# --- What DSTNS needs ----------------------------------------------------------------


def _runs(command: list[str], pattern: str = "") -> str | None:
    """The first line matching ``pattern`` from running ``command``, or None if it does not run."""
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL, errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    text = (result.stdout + result.stderr).strip()
    if pattern:
        match = re.search(pattern, text)
        return match.group(1) if match else text.splitlines()[0] if text else ""
    return text.splitlines()[0] if text else ""


def _include_dirs() -> list[Path]:
    dirs = [Path("/usr/include"), Path("/usr/local/include"), Path("/opt/homebrew/include")]
    sdk = _runs(["xcrun", "--show-sdk-path"]) if sys.platform == "darwin" else None
    if sdk:
        dirs.insert(0, Path(sdk) / "usr" / "include")
    return dirs


def _header(name: str) -> str | None:
    return next((str(d / name) for d in _include_dirs() if (d / name).exists()), None)


def _library(names: list[str]) -> str | None:
    prefixes = ["/opt/homebrew/lib", "/usr/local/lib", "/usr/lib", "/usr/lib64", f"/usr/lib/{platform.machine()}-linux-gnu",
                "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu"]
    return next((f"{p}/{n}" for p in prefixes for n in names if Path(p, n).exists()), None)


def _version_at_least(text: str | None, minimum: tuple[int, ...]) -> bool:
    if not text:
        return False
    numbers = re.findall(r"\d+", text)
    try:
        return tuple(int(n) for n in numbers[:len(minimum)]) >= minimum
    except ValueError:
        return False


@dataclass(frozen=True)
class Dependency:
    key: str
    name: str
    purpose: str                       # "build", "runtime", "observer", "sumo", "gpu", "gpu-build"
    detect: Callable[[], str | None]   # a found version or location, or None
    packages: dict[str, tuple[str, ...]] = field(default_factory=dict)  # manager -> packages
    note: str = ""                     # what to do where no package can be installed for you
    platforms: tuple[str, ...] = ("macos", "linux")
    minimum: str = ""


def _compiler() -> str | None:
    for tool in ("c++", "clang++", "g++"):
        found = _runs([tool, "--version"])
        if found:
            return found
    return None


def _node() -> str | None:
    found = _runs(["node", "--version"])
    return found if _version_at_least(found, (20,)) else None


def _cmake() -> str | None:
    found = _runs(["cmake", "--version"], r"version\s+(\S+)")
    return found if _version_at_least(found, (3, 22)) else None


def _python() -> str | None:
    return platform.python_version() if sys.version_info >= (3, 10) else None


def _sumo() -> str | None:
    from .sumo import detect

    found = detect()
    return (found.version or "found") if found and found.works else None


def _vulkan_loader() -> str | None:
    return _library(["libvulkan.1.dylib", "libvulkan.dylib", "libvulkan.so.1"])


def _moltenvk() -> str | None:
    keg = Path("/opt/homebrew/opt/molten-vk/lib/libMoltenVK.dylib")
    return _library(["libMoltenVK.dylib"]) or (str(keg) if keg.exists() else None)


MANIFEST: tuple[Dependency, ...] = (
    Dependency("compiler", "C++20 compiler", "build", _compiler,
               {"apt": ("build-essential",), "dnf": ("gcc-c++", "make"), "pacman": ("base-devel",)},
               note="macOS: install the Xcode Command Line Tools with  xcode-select --install"),
    Dependency("cmake", "CMake 3.22+", "build", _cmake,
               {"brew": ("cmake",), "apt": ("cmake",), "dnf": ("cmake",), "pacman": ("cmake",)}, minimum="3.22"),
    Dependency("python", "Python 3.10+", "runtime", _python,
               {"brew": ("python@3.13",), "apt": ("python3", "python3-venv"), "dnf": ("python3",), "pacman": ("python",)},
               minimum="3.10"),
    Dependency("sqlite", "SQLite headers", "build", lambda: _header("sqlite3.h"),
               {"apt": ("libsqlite3-dev",), "dnf": ("sqlite-devel",), "pacman": ("sqlite",)},
               note="macOS: part of the Xcode Command Line Tools"),
    Dependency("zlib", "zlib headers", "build", lambda: _header("zlib.h"),
               {"apt": ("zlib1g-dev",), "dnf": ("zlib-devel",), "pacman": ("zlib",)},
               note="macOS: part of the Xcode Command Line Tools"),
    Dependency("node", "Node.js 20+ and npm", "observer", _node,
               {"brew": ("node",), "apt": ("nodejs", "npm"), "dnf": ("nodejs", "npm"), "pacman": ("nodejs", "npm")},
               note="Some distributions ship an older Node.js; see nodejs.org for current packages.", minimum="20"),
    Dependency("sumo", "Eclipse SUMO", "sumo", _sumo,
               {"brew": ("dlr-ts/sumo/sumo",), "apt": ("sumo", "sumo-tools"), "dnf": ("sumo",)},
               note="Arch: SUMO is in the AUR (sumo); install it with your AUR helper."),
    Dependency("vulkan", "Vulkan loader", "gpu", _vulkan_loader,
               {"brew": ("vulkan-loader",), "apt": ("libvulkan1",), "dnf": ("vulkan-loader",), "pacman": ("vulkan-icd-loader",)}),
    Dependency("moltenvk", "MoltenVK (Vulkan on Metal)", "gpu", _moltenvk, {"brew": ("molten-vk",)}, platforms=("macos",)),
    Dependency("vulkaninfo", "Vulkan diagnostics (vulkaninfo)", "gpu", lambda: shutil.which("vulkaninfo"),
               {"brew": ("vulkan-tools",), "apt": ("vulkan-tools",), "dnf": ("vulkan-tools",), "pacman": ("vulkan-tools",)}),
    Dependency("glslang", "Shader compiler (glslang)", "gpu-build",
               lambda: shutil.which("glslangValidator") or shutil.which("glslc"),
               {"brew": ("glslang",), "apt": ("glslang-tools",), "dnf": ("glslang",), "pacman": ("glslang",)},
               note="Only needed to change the compute shaders; the committed SPIR-V is used otherwise."),
)

#: Which purposes each profile prepares.
PROFILES = {
    "minimal": ("build", "runtime"),
    "standard": ("build", "runtime", "observer", "gpu"),
    "full": ("build", "runtime", "observer", "gpu", "sumo", "gpu-build"),
}


@dataclass
class Status:
    dependency: Dependency
    found: str | None

    @property
    def present(self) -> bool:
        return self.found is not None


def survey(target: Platform, purposes: tuple[str, ...] | None = None) -> list[Status]:
    """Detect every dependency that applies to this platform."""
    return [Status(d, d.detect()) for d in MANIFEST
            if target.system in d.platforms and (purposes is None or d.purpose in purposes)]


# --- Providers: one per package manager ------------------------------------------------------


@dataclass(frozen=True)
class Provider:
    manager: str
    needs_root: bool
    install: tuple[str, ...]
    refresh: tuple[str, ...] = ()
    taps: dict[str, tuple[str, ...]] = field(default_factory=dict)  # package -> command run first

    def commands(self, packages: list[str], *, assume_yes: bool, root: bool) -> list[list[str]]:
        prefix = ["sudo"] if self.needs_root and not root else []
        out: list[list[str]] = []
        for package in packages:
            if package in self.taps:
                out.append(list(self.taps[package]))
        if self.refresh:
            out.append(prefix + list(self.refresh))
        command = prefix + list(self.install)
        if assume_yes:
            command += {"apt": ["-y"], "dnf": ["-y"], "pacman": ["--noconfirm"]}.get(self.manager, [])
        out.append(command + packages)
        return out


PROVIDERS: dict[str, Provider] = {
    # Homebrew refuses to run as root, and needs no sudo. The SUMO formula lives
    # in the DLR's own tap: DLR maintains SUMO.
    "brew": Provider("brew", False, ("brew", "install"), taps={"dlr-ts/sumo/sumo": ("brew", "tap", "dlr-ts/sumo")}),
    "apt": Provider("apt", True, ("apt-get", "install", "--no-install-recommends"), refresh=("apt-get", "update")),
    "dnf": Provider("dnf", True, ("dnf", "install")),
    "pacman": Provider("pacman", True, ("pacman", "-S", "--needed")),
}


@dataclass
class Plan:
    platform: Platform
    statuses: list[Status]
    packages: list[str]
    commands: list[list[str]]
    manual: list[tuple[str, str]]     # (dependency, what the operator must do)
    notes: list[str]

    @property
    def needed(self) -> bool:
        return bool(self.commands)

    @property
    def missing(self) -> list[Status]:
        return [s for s in self.statuses if not s.present]


def plan(target: Platform, profile: str = "standard", *, assume_yes: bool = False,
         statuses: list[Status] | None = None) -> Plan:
    if profile not in PROFILES:
        raise DependencyError(f"Unknown profile: {profile}", remedy="Use minimal, standard or full.")
    statuses = statuses if statuses is not None else survey(target, PROFILES[profile])
    provider = PROVIDERS.get(target.manager)
    packages: list[str] = []
    manual: list[tuple[str, str]] = []
    for status in statuses:
        if status.present:
            continue
        names = list(status.dependency.packages.get(target.manager, ())) if provider else []
        if names:
            packages += [n for n in names if n not in packages]
        else:
            manual.append((status.dependency.name, status.dependency.note or "install it with your system's package manager"))
    notes: list[str] = []
    if target.system == "macos" and not provider:
        notes.append("Homebrew is not installed. DSTNS does not install it for you; see https://brew.sh, then run this again.")
    if target.system == "other":
        notes.append("Only macOS and Linux are supported; use WSL 2 or Docker on Windows.")
    notes.append("GPU drivers are never installed by DSTNS. Without a hardware Vulkan driver the simulation runs on the CPU.")
    if target.wsl:
        notes.append("WSL 2: GPU access comes from the Windows driver through Mesa's D3D12 (Dozen) Vulkan driver.")
    if target.container:
        notes.append("In a container a GPU is visible only if the host passes it in (for example --device /dev/dri).")
    root = hasattr(os, "geteuid") and os.geteuid() == 0
    commands = provider.commands(packages, assume_yes=assume_yes, root=root) if provider and packages else []
    return Plan(target, statuses, packages, commands, manual, notes)


def execute(the_plan: Plan, reporter: Reporter) -> list[Status]:
    """Run the plan's commands, then detect everything again."""
    from . import process

    if the_plan.commands and the_plan.platform.manager != "brew" and not (hasattr(os, "geteuid") and os.geteuid() == 0) \
            and not shutil.which("sudo"):
        raise DependencyError("Installing packages needs root, and sudo is not available.",
                              remedy="Run ./launcher bootstrap as root, or install the packages listed above yourself.")
    for command in the_plan.commands:
        title = " ".join(command[:4]) + (" …" if len(command) > 4 else "")
        reporter.step_started(title)
        try:
            # Interactive: sudo and the package manager may need the terminal.
            completed = subprocess.run(command, check=False)
        except OSError as exc:
            reporter.step_finished(title, False, str(exc))
            raise DependencyError(f"{command[0]} could not be run: {exc}") from exc
        reporter.step_finished(title, completed.returncode == 0, "" if completed.returncode == 0 else f"exit status {completed.returncode}")
        if completed.returncode != 0:
            raise DependencyError(f"{' '.join(command[:3])} failed with status {completed.returncode}.",
                                  remedy="Read the package manager's message above, fix the cause, and run ./launcher bootstrap again.")
        process.LOG.info("bootstrap: %s", " ".join(command))
    after = [Status(s.dependency, s.dependency.detect()) for s in the_plan.statuses]
    still = [s for s in after if not s.present]
    if still:
        reporter.message(Level.WARNING, "Still missing after installation", ", ".join(s.dependency.name for s in still))
    else:
        reporter.message(Level.SUCCESS, "Every dependency is now present")
    return after
