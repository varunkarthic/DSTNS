# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Where the launcher finds and writes things.

Every path is derived from the repository root, so the launcher works from any
working directory. ``DSTNS_LOGS_DIR`` moves the logs directory, as it always has.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def config(self) -> Path:
        return self.root / "config" / "defaults.json"

    @property
    def ui_config(self) -> Path:
        return self.root / "config" / "ui-config.json"

    @property
    def logs(self) -> Path:
        override = os.environ.get("DSTNS_LOGS_DIR")
        return Path(override).resolve() if override else self.root / "logs"

    @property
    def active_server(self) -> Path:
        return self.logs / "launcher.json"

    @property
    def launcher_log(self) -> Path:
        return self.logs / "launcher.log"

    @property
    def token(self) -> Path:
        return self.logs / "operator.token"

    @property
    def runtime_db(self) -> Path:
        return self.logs / "runtime.db"

    @property
    def system_log(self) -> Path:
        return self.logs / "system.log"

    @property
    def build(self) -> Path:
        return self.root / "build"

    @property
    def server(self) -> Path:
        return self.build / "dstns_server"

    @property
    def export_tool(self) -> Path:
        return self.build / "dstns_scenario_export"

    @property
    def ui_engine(self) -> Path:
        return self.root / "ui-engine"

    @property
    def ui_dist(self) -> Path:
        return self.ui_engine / "dist"

    @property
    def seed_store(self) -> Path:
        override = os.environ.get("DSTNS_SEED_DB")
        return Path(override) if override else self.root / "data" / "seed-store" / "seeds.sqlite3"


PATHS = Paths(ROOT)
