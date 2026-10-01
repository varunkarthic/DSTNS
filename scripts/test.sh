#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/build.sh"
ctest --test-dir "$root/build" --output-on-failure
npm test --prefix "$root/ui-engine"
python3 "$root/tests/api/api_smoke.py" --server "$root/build/dstns_server"
python3 "$root/tests/cli/test_fetch_osm.py"
python3 "$root/tests/cli/test_seeds.py"
python3 "$root/tests/launcher/test_core.py"
python3 "$root/tests/launcher/test_interfaces.py"

python3 "$root/tests/api/loading_smoke.py"
