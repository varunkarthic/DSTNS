# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Say, on every page, which versions of DSTNS the documentation describes.

Each version is read from where the build itself takes it, so the notice cannot fall behind the code:

    the server and core-legacy   CMakeLists.txt         project(dstns VERSION ...)
    core-ng                      Core/core-ng/include/dstns/core-ng/identity.hpp   kVersion
    the API contract             Core/common/include/dstns/model.hpp               kApiVersion
    the launcher                 LaunchKit/Cargo.toml   version
    the observer                 WebKit/package.json    version

They are given to the templates as config.extra.dstns_versions (overrides/main.html draws the notice) and to pages as
{{ dstns_versions.server }} and the like, through the macros-free substitution below.
"""

import json
import re
from pathlib import Path

from mkdocs.config.defaults import MkDocsConfig

_PATTERNS = {
    "server": ("CMakeLists.txt", r"project\(\s*dstns\s+VERSION\s+([0-9.]+)"),
    "core_ng": ("Core/core-ng/include/dstns/core-ng/identity.hpp", r'kVersion\s*=\s*"([0-9.]+)"'),
    "api": ("Core/common/include/dstns/model.hpp", r'kApiVersion\s*=\s*"([0-9.]+)"'),
    "launcher": ("LaunchKit/Cargo.toml", r'^version\s*=\s*"([0-9.]+)"'),
}


def read_versions(root: Path) -> dict:
    out = {}
    for key, (file, pattern) in _PATTERNS.items():
        text = (root / file).read_text(encoding="utf-8")
        found = re.search(pattern, text, re.M)
        if not found:
            raise ValueError(f"no version for {key} in {file}")
        out[key] = found.group(1)
    out["observer"] = json.loads((root / "WebKit/package.json").read_text(encoding="utf-8"))["version"]
    out["core_legacy"] = out["server"]
    return out


def on_config(config: MkDocsConfig, **_) -> MkDocsConfig:
    root = Path(config.config_file_path).parent
    config.extra["dstns_versions"] = read_versions(root)
    return config


def on_page_markdown(markdown: str, config: MkDocsConfig, **_) -> str:
    # {{ version.server }} and the like in a page, for the few that state a version in their text.
    versions = config.extra["dstns_versions"]
    return re.sub(r"\{\{\s*version\.([a-z_]+)\s*\}\}", lambda m: versions.get(m.group(1), m.group(0)), markdown)
