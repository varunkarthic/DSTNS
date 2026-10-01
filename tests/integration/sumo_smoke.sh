#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
command -v netconvert >/dev/null
command -v sumo >/dev/null
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$root/build/dstns_scenario_export" "$tmp"
netconvert --node-files "$tmp/network.nod.xml" --edge-files "$tmp/network.edg.xml" --output-file "$tmp/network.net.xml" --no-warnings true
sumo -c "$tmp/sandbox.sumocfg" --end 600 --no-warnings true
test -s "$tmp/network.net.xml"
echo "DSTNS SUMO integration smoke passed"
