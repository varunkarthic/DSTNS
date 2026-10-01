# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Version the site's own CSS and JavaScript by content.

Read the Docs lets browsers and its CDN keep static files for 30 minutes. Without a
version in the URL, a visitor can be served last build's stylesheet next to this build's
HTML. Appending a short hash of each file's bytes means a changed file always has a new
URL and an unchanged one keeps its cache entry.
"""

import hashlib
from pathlib import Path

from mkdocs.config.defaults import MkDocsConfig
from mkdocs.config.config_options import ExtraScriptValue


def _digest(docs_dir: str, path: str) -> str:
    file = Path(docs_dir) / path
    if not file.is_file():
        return ""
    return hashlib.sha256(file.read_bytes()).hexdigest()[:10]


def _versioned(docs_dir: str, path: str) -> str:
    if "://" in path or "?" in path:
        return path
    digest = _digest(docs_dir, path)
    return f"{path}?v={digest}" if digest else path


def on_config(config: MkDocsConfig) -> MkDocsConfig:
    docs_dir = config["docs_dir"]
    config["extra_css"] = [_versioned(docs_dir, p) for p in config["extra_css"]]
    scripts = []
    for script in config["extra_javascript"]:
        scripts.append(ExtraScriptValue(_versioned(docs_dir, str(script))) if not str(script).startswith("http") else script)
    config["extra_javascript"] = scripts
    return config
