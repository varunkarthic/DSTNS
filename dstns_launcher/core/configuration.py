# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""``config/defaults.json``: loading, validation, editing and the start request.

The launcher edits the existing configuration file; it keeps no configuration of
its own. The bounds are the engine's, so a configuration accepted here is one
the engine accepts.
"""
from __future__ import annotations

import copy
import json
import os
import re
import secrets
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from .errors import ConfigurationError
from .paths import PATHS, Paths

# The engine refuses anything faster (kMaxTickRate in include/dstns/model.hpp).
MAX_TICK_RATE = 5.0
MAP_SELECTION_VERSION = "urban-crfg-v3"
_SEED = re.compile(r"^(?:0x[0-9a-fA-F]{1,32}|[0-9]{1,39})$")


def load(paths: Paths = PATHS) -> dict[str, Any]:
    """Read and validate ``config/defaults.json``."""
    try:
        text = paths.config.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ConfigurationError(
            f"{_relative(paths.config, paths)} is missing.",
            remedy="Restore it from the repository: git checkout -- config/defaults.json",
        ) from exc
    try:
        config = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigurationError(
            f"{_relative(paths.config, paths)} is not valid JSON (line {exc.lineno}, column {exc.colno}).",
            remedy="Correct the file, or restore it with git checkout -- config/defaults.json",
        ) from exc
    validate(config)
    return config


def validate(config: dict[str, Any]) -> None:
    """The checks the launcher has always made before a run."""
    playback = config.get("playback") or {}
    api = config.get("api") or {}
    duration, tick, port = playback.get("duration_seconds"), playback.get("tick_rate"), api.get("port")
    if not _is_int(duration) or not 60 <= duration <= 3600:
        raise ConfigurationError("playback.duration_seconds must be an integer in [60, 3600]")
    if not _is_number(tick) or not 0 < tick <= MAX_TICK_RATE:
        raise ConfigurationError(f"playback.tick_rate must be in (0, {MAX_TICK_RATE:g}]")
    if not _is_int(port) or not 1 <= port <= 65535:
        raise ConfigurationError("api.port must be an integer in [1, 65535]")
    if not api.get("host"):
        raise ConfigurationError("api.host must be configured")
    compute = config.get("compute")
    if compute is not None:
        if not isinstance(compute, dict):
            raise ConfigurationError("compute must be an object")
        if compute.get("backend", "auto") not in ("auto", "cpu", "vulkan"):
            raise ConfigurationError("compute.backend must be auto, cpu or vulkan")
        for key in ("allow_vulkan", "allow_software_vulkan", "require_vulkan", "verification", "validation_layers"):
            if key in compute and not isinstance(compute[key], bool):
                raise ConfigurationError(f"compute.{key} must be true or false")
        device = compute.get("device", "auto")
        if not isinstance(device, str) or not device.strip() or len(device) > 256 or "\n" in device:
            raise ConfigurationError("compute.device must be auto, a device index, a UUID or part of a device name")
        for key, value in ((compute.get("gpu_thresholds") or {}).items()):
            if key not in ("min_nodes", "min_edges") or not _is_int(value) or not 0 <= value <= 100_000_000:
                raise ConfigurationError(f"compute.gpu_thresholds.{key} must be a whole number in [0, 100000000]")


def save(config: dict[str, Any], paths: Paths = PATHS) -> None:
    """Validate, then write atomically in the file's existing format."""
    validate(config)
    for field in FIELDS:
        problem = check_field(field, field.get(config), config)
        if problem:
            raise ConfigurationError(f"{field.label}: {problem}")
    text = json.dumps(config, indent=2, ensure_ascii=False) + "\n"
    temporary = paths.config.with_suffix(".json.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, paths.config)


# --- Editable fields ---------------------------------------------------------


class Kind(Enum):
    INTEGER = "integer"
    NUMBER = "number"
    BOOLEAN = "boolean"
    TEXT = "text"
    CHOICE = "choice"


@dataclass(frozen=True)
class Field:
    """One setting the configuration screen can edit.

    Only settings that the CLI or the engine actually read are listed; the
    informational keys in defaults.json are left alone.
    """

    key: str
    label: str
    category: str
    kind: Kind
    help: str
    unit: str = ""
    minimum: float | None = None
    maximum: float | None = None
    exclusive_minimum: bool = False
    choices: tuple[tuple[str, Any], ...] = ()
    default: Any = None
    extra: Callable[[Any, dict[str, Any]], str] | None = None

    def get(self, config: dict[str, Any]) -> Any:
        node: Any = config
        for part in self.key.split("."):
            if not isinstance(node, dict) or part not in node:
                return self.default
            node = node[part]
        return node

    def set(self, config: dict[str, Any], value: Any) -> None:
        node = config
        parts = self.key.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value

    def parse(self, text: str) -> Any:
        """Turn what the operator typed into a value, or raise ConfigurationError."""
        text = text.strip()
        if self.kind is Kind.INTEGER:
            if not re.fullmatch(r"-?[0-9]+", text):
                raise ConfigurationError("Enter a whole number.")
            value: Any = int(text)
        elif self.kind is Kind.NUMBER:
            try:
                value = float(text)
            except ValueError as exc:
                raise ConfigurationError("Enter a number.") from exc
            if value.is_integer() and "." not in text:
                value = int(value)
        elif self.kind is Kind.BOOLEAN:
            lowered = text.lower()
            if lowered not in {"true", "false", "on", "off", "yes", "no", "1", "0"}:
                raise ConfigurationError("Enter on or off.")
            value = lowered in {"true", "on", "yes", "1"}
        elif self.kind is Kind.CHOICE:
            for label, choice in self.choices:
                if text.lower() in {label.lower(), str(choice).lower()}:
                    value = choice
                    break
            else:
                raise ConfigurationError("Choose one of: " + ", ".join(label for label, _ in self.choices) + ".")
        else:
            value = text
        problem = self.check(value)
        if problem:
            raise ConfigurationError(problem)
        return value

    def check(self, value: Any) -> str:
        """An explanation of what is wrong with ``value``, or ``""``."""
        if self.kind is Kind.INTEGER and not _is_int(value):
            return "must be a whole number."
        if self.kind is Kind.NUMBER and not _is_number(value):
            return "must be a number."
        if self.kind is Kind.BOOLEAN and not isinstance(value, bool):
            return "must be on or off."
        if self.kind is Kind.TEXT and (not isinstance(value, str) or not value.strip()):
            return "must not be empty."
        if self.kind is Kind.CHOICE and value not in {choice for _, choice in self.choices}:
            return "is not one of the allowed values."
        if self.minimum is not None and _is_number(value):
            if value < self.minimum or (self.exclusive_minimum and value == self.minimum):
                return self.range_text()
        if self.maximum is not None and _is_number(value) and value > self.maximum:
            return self.range_text()
        return ""

    def range_text(self) -> str:
        if self.maximum is None:
            return f"Must be at least {self.minimum:g}."
        if self.exclusive_minimum:
            return f"Must be greater than {self.minimum:g} and at most {self.maximum:g}."
        return f"Must be between {self.minimum:g} and {self.maximum:g}."

    def display(self, value: Any) -> str:
        if self.kind is Kind.BOOLEAN:
            return "on" if value else "off"
        if self.kind is Kind.CHOICE:
            for label, choice in self.choices:
                if choice == value:
                    return label
        return "" if value is None else str(value)


def _dws_spacing(value: Any, config: dict[str, Any]) -> str:
    duration = (config.get("playback") or {}).get("duration_seconds")
    if _is_int(value) and _is_int(duration) and value > 0 and (value - 1) * 5 >= duration:
        return "Storms must start at least 5 playback seconds apart; lower the count or lengthen the day."
    return ""


FIELDS: tuple[Field, ...] = (
    Field("day", "Day type", "Run", Kind.CHOICE,
          "Weekday or weekend demand profiles; auto uses the seed's own day type. --day-type overrides it.",
          choices=(("auto", "auto"), ("weekday", 0), ("weekend", 1)), default="auto"),
    Field("playback.duration_seconds", "Day duration", "Run", Kind.INTEGER,
          "Wall-clock seconds one virtual day takes at 1×.", unit="seconds", minimum=60, maximum=3600, default=3600),
    Field("playback.tick_rate", "Speed", "Run", Kind.NUMBER,
          "Initial playback multiplier.", unit="×", minimum=0, exclusive_minimum=True, maximum=MAX_TICK_RATE,
          default=1.0),
    Field("map.max_nodes", "Graph size cap", "Map", Kind.INTEGER,
          "Upper bound on the number of junctions.", unit="nodes", minimum=2, maximum=50000, default=50000),
    Field("map.cache_dir", "Map cache", "Map", Kind.TEXT,
          "Where downloaded city extracts are kept.", default="data/maps"),
    Field("modules.traffic", "Traffic demand", "Modules", Kind.BOOLEAN, "Base and hotspot demand on every road.", default=True),
    Field("modules.signals", "Traffic signals", "Modules", Kind.BOOLEAN, "Signal controllers at junctions.", default=True),
    Field("modules.buildings", "Places", "Modules", Kind.BOOLEAN, "Demand from schools, offices, shops and other places.", default=True),
    Field("modules.dws", "Weather", "Modules", Kind.BOOLEAN, "Scheduled and manual rain.", default=True),
    Field("modules.flooding", "Flooding", "Modules", Kind.BOOLEAN, "Standing water and flood closures.", default=True),
    Field("modules.news", "News", "Modules", Kind.BOOLEAN, "The operator news feed.", default=True),
    Field("dws.frequency", "Storms per day", "Weather", Kind.INTEGER,
          "Scheduled storms in a virtual day.", unit="storms", minimum=0, default=3, extra=_dws_spacing),
    Field("compute.backend", "Compute backend", "Compute", Kind.CHOICE,
          "auto runs the physics on a GPU (Vulkan) only where it is measured faster; cpu never uses a GPU; "
          "vulkan uses one for every world. Results are identical whichever runs.",
          choices=(("auto", "auto"), ("cpu", "cpu"), ("vulkan", "vulkan")), default="auto"),
    Field("compute.allow_vulkan", "GPU acceleration", "Compute", Kind.BOOLEAN,
          "Off keeps the simulator on the CPU whatever the backend says.", default=True),
    Field("compute.device", "GPU", "Compute", Kind.TEXT,
          "auto, a device index, a device UUID, or part of a name (for example \"M4\" or \"Radeon\").", default="auto"),
    Field("compute.require_vulkan", "Require Vulkan", "Compute", Kind.BOOLEAN,
          "With the vulkan backend: refuse to start without a working GPU instead of using the CPU.", default=False),
    Field("compute.allow_software_vulkan", "Software Vulkan", "Compute", Kind.BOOLEAN,
          "Allow CPU implementations of Vulkan such as llvmpipe. For testing; slower than the CPU backend.", default=False),
    Field("compute.verification", "Verify GPU steps", "Compute", Kind.BOOLEAN,
          "Recompute every GPU step on the CPU and compare. For diagnosis; much slower.", default=False),
    Field("compute.validation_layers", "Vulkan validation", "Compute", Kind.BOOLEAN,
          "Run with the Khronos validation layers when they are installed. For development.", default=False),
    Field("compute.gpu_thresholds.min_nodes", "GPU from nodes", "Compute", Kind.INTEGER,
          "auto: below this many junctions (and the edge count below) the CPU is used without measuring.",
          unit="nodes", minimum=0, maximum=100_000_000, default=40000),
    Field("compute.gpu_thresholds.min_edges", "GPU from edges", "Compute", Kind.INTEGER,
          "auto: below this many directed edges (and the node count above) the CPU is used without measuring.",
          unit="edges", minimum=0, maximum=100_000_000, default=150000),
    Field("api.host", "Bind address", "Server", Kind.TEXT,
          "127.0.0.1 keeps the server local; 0.0.0.0 exposes it to the network.", default="127.0.0.1"),
    Field("api.port", "Port", "Server", Kind.INTEGER,
          "Preferred port; the next free one is used if it is taken.", minimum=1, maximum=65535, default=8090),
)

CATEGORIES: tuple[str, ...] = tuple(dict.fromkeys(field.category for field in FIELDS))


def check_field(field: Field, value: Any, config: dict[str, Any]) -> str:
    problem = field.check(value)
    if not problem and field.extra:
        problem = field.extra(value, config)
    return problem


# --- Run options and the start request ----------------------------------------


@dataclass
class RunOptions:
    """What the operator asked for, before defaults are applied."""

    seed: str | None = None
    saved_seed: str | None = None
    save_seed: str | None = None
    description: str | None = None
    day_type: str | None = None
    # Constraints for a generated seed: the seed is searched for, never overridden.
    location: str | None = None
    month: str | None = None
    duration: str | None = None
    speed: str | None = None
    max_nodes: str | None = None
    osm_file: str | None = None

    def explicit(self) -> bool:
        return any(
            getattr(self, name) is not None
            for name in ("seed", "saved_seed", "save_seed", "day_type", "location", "month", "osm_file", "max_nodes",
                         "duration", "speed")
        )


def normalise_seed(text: str) -> str:
    """A seed exactly as the engine and the observer show it: decimal."""
    if not _SEED.match(text):
        raise ConfigurationError("Seed must be a decimal integer or 0x hexadecimal, within 128 bits")
    value = int(text, 0) if text.lower().startswith("0x") else int(text)
    if value >= 1 << 128:
        raise ConfigurationError("Seed exceeds 128 bits")
    return str(value)


def fresh_seed() -> str:
    """A new 64-bit seed: short enough to read off the screen and retype."""
    return str(int.from_bytes(secrets.token_bytes(8), "big"))


MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december")
DAY_TYPES = {"weekday", "weekend", "auto"}


def check_month(text: str) -> None:
    """Refuse a month the engine would refuse, before anything starts."""
    value = text.strip().lower()
    if value == "auto" or (value.isdigit() and len(value) <= 2 and 1 <= int(value) <= 12):
        return
    if value in MONTHS or (len(value) == 3 and any(m.startswith(value) for m in MONTHS)):
        return
    raise ConfigurationError("--month must be 1 to 12, a month name, or auto")


def constrained_seed(location: str | None, month: str | None, day_type: str | None,
                     paths: Paths = PATHS) -> dict[str, Any]:
    """A fresh seed whose own location, month and day type are the ones given.

    The engine owns the city catalogue and the derivations, so the search runs
    in the server binary (``dstns_server --generate-seed``) rather than being
    reimplemented here, where the two could drift apart.
    """
    import subprocess

    if not paths.server.exists():
        raise ConfigurationError("Choosing a location or month needs the engine built first.",
                                 remedy="Run ./launcher start once, or cmake --build build.")
    command = [str(paths.server), "--generate-seed"]
    for flag, value in (("--location", location), ("--month", month), ("--day-type", day_type)):
        if value and value.lower() != "auto":
            command += [flag, value]
    result = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip().removeprefix("DSTNS fatal: ")
        raise ConfigurationError(message or "The engine could not generate a seed.",
                                 remedy="./build/dstns_server --generate-seed --help lists the options.")
    return json.loads(result.stdout)


def start_request(
    options: RunOptions,
    *,
    paths: Paths = PATHS,
    use_saved: Callable[[str], dict[str, Any]] | None = None,
    generate: Callable[[str | None, str | None, str | None, Paths], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The body of ``POST /api/v1/playback/start`` for these options."""
    if options.seed and options.saved_seed:
        raise ConfigurationError("--seed and --saved-seed are mutually exclusive")
    if options.day_type is not None and options.day_type not in DAY_TYPES:
        raise ConfigurationError("--day-type must be weekday or weekend (or auto, the seed's own)")
    if options.month is not None:
        check_month(options.month)
    constrained = bool(options.location or options.month)
    if constrained and (options.seed or options.saved_seed):
        raise ConfigurationError("--location and --month choose the seed; they cannot be combined with --seed or --saved-seed",
                                 remedy="Drop --seed to have a seed generated, or drop --location and --month.")
    if options.saved_seed:
        if use_saved is None:
            from . import seeds

            use_saved = lambda name: seeds.operate("use", {"id": name}, paths=paths)  # noqa: E731
        request = copy.deepcopy(use_saved(options.saved_seed)["config"])
    else:
        defaults = load(paths)
        if constrained:
            # The generated seed itself carries the location, month and day
            # type, so the request leaves them to the seed.
            generated = (generate or constrained_seed)(options.location, options.month, options.day_type, paths)
            seed = str(generated["seed"])
        else:
            seed = normalise_seed(options.seed) if options.seed else fresh_seed()
        # "auto" lets the seed choose a real city district; a path pins a file.
        source = options.osm_file or (defaults.get("map") or {}).get("osm_file") or "auto"
        map_options: dict[str, Any] = {
            "osm_file": "auto" if source == "auto" else str((paths.root / source).resolve()),
            "max_nodes": defaults["map"]["max_nodes"],
        }
        for key in ("tile_radius_m", "cache_dir"):
            if defaults["map"].get(key):
                map_options[key] = defaults["map"][key]
        request = {
            "seed": seed,
            "day": defaults.get("day", "auto"),
            "playback_duration_seconds": defaults["playback"]["duration_seconds"],
            "tick_rate": defaults["playback"]["tick_rate"],
            "map": map_options,
            "modules": defaults.get("modules"),
            "dws": defaults.get("dws"),
            "map_selection_version": MAP_SELECTION_VERSION,
        }
    if options.osm_file:
        request["map"]["osm_file"] = str((paths.root / options.osm_file).resolve())
    if request["map"]["osm_file"] != "auto" and not Path(request["map"]["osm_file"]).exists():
        raise ConfigurationError("OSM data unavailable; provide --osm-file PATH")
    if constrained:
        request["day"] = "auto"
        request.pop("month", None)
    elif options.day_type:
        request["day"] = {"weekend": 1, "weekday": 0}.get(options.day_type, "auto")
    for value, key, minimum, maximum, integer in (
        (options.duration, "duration", 60, 3600, True),
        (options.speed, "speed", 0.01, MAX_TICK_RATE, False),
        (options.max_nodes, "max-nodes", 2, 50000, True),
    ):
        if not value:
            continue
        try:
            number = float(value)
        except ValueError:
            number = float("nan")
        if not (minimum <= number <= maximum) or (integer and not number.is_integer()):
            raise ConfigurationError(f"--{key} must be in [{minimum:g},{maximum:g}]")
        if key == "max-nodes":
            request["map"]["max_nodes"] = int(number)
        elif key == "duration":
            request["playback_duration_seconds"] = int(number)
        else:
            request["tick_rate"] = int(number) if number.is_integer() else number
    tick = request.get("tick_rate")
    if not _is_number(tick) or not 0 < tick <= MAX_TICK_RATE:
        raise ConfigurationError(f"tick_rate must be in (0, {MAX_TICK_RATE:g}]")
    return request


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value


def _relative(path: Path, paths: Paths) -> str:
    try:
        return str(path.relative_to(paths.root))
    except ValueError:
        return str(path)
