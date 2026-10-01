#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$root/launcher.py" reset
