#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/build/dstns_server" --logs "$root/logs" & engine_pid=$!
trap 'kill "$engine_pid" 2>/dev/null || true' EXIT
exec npm run dev --prefix "$root/ui-engine"
