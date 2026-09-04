#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cmake -S "$root" -B "$root/build" -DCMAKE_BUILD_TYPE="${BUILD_TYPE:-Release}" -DDSTNS_BUILD_TESTS=ON
cmake --build "$root/build" -j"${BUILD_JOBS:-4}"
npm run build --prefix "$root/ui-engine"
