#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/build.sh"
ctest --test-dir "$root/build" --output-on-failure
npm test --prefix "$root/ui-engine"
python3 "$root/tests/api/api_smoke.py" --server "$root/build/dstns_server"
python3 "$root/tests/cli/test_fetch_osm.py"
python3 "$root/tests/cli/test_seeds.py"

python3 "$root/tests/api/loading_smoke.py"
