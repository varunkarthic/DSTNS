# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Content fingerprints: rebuild an output only when its sources changed.

The fingerprint hashes each file's relative path and bytes, in sorted order, so
it matches the one the launcher has always written to ``.launcher-source``.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path


def source_fingerprint(root: Path, inputs: list[str]) -> str:
    digest = hashlib.sha256()

    def add(relative: str) -> None:
        full = root / relative
        if full.is_dir():
            for name in sorted(child.name for child in full.iterdir()):
                add(str(Path(relative) / name))
        elif full.is_file():
            digest.update(relative.encode())
            digest.update(b"\0")
            digest.update(full.read_bytes())

    for item in inputs:
        add(item)
    return digest.hexdigest()


@dataclass(frozen=True)
class BuildState:
    fingerprint: str
    needed: bool


def needs_build(root: Path, inputs: list[str], output: Path, stamp: Path) -> BuildState:
    fingerprint = source_fingerprint(root, inputs)
    try:
        previous = stamp.read_text(encoding="utf-8")
    except OSError:
        previous = None
    return BuildState(fingerprint, not output.exists() or previous != fingerprint)
