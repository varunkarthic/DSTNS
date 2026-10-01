#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""DSTNS launcher, for ``python3 launcher.py``. Equivalent to ``./launcher``."""
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
os.environ["PYTHONPATH"] = os.pathsep.join(filter(None, [ROOT, os.environ.get("PYTHONPATH")]))

from dstns_launcher.cli import entry  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(entry())
