#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

# Every suite: the engine's and the HTTP tests (ctest), the launcher's (cargo) and the observer's (Vitest).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/build.sh"
ctest --test-dir "$root/build" --output-on-failure
cargo test --release --manifest-path "$root/LaunchKit/Cargo.toml"
npm test --prefix "$root/WebKit"
