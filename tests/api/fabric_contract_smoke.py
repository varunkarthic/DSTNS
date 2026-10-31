#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The HTTP contract Fabric must preserve, checked against a recorded baseline.

fabric_contract.golden.json was recorded from the server as it stood before the
API moved under Fabric. Each route is called with the same request and compared:
the status must match, every recorded response key must still exist with the same
type, and recorded headers must match. New routes and new keys are allowed, which
is the compatibility promise in docs/api/versioning.md.

    tests/api/fabric_contract_smoke.py            compare
    tests/api/fabric_contract_smoke.py --record   rewrite the baseline (only for an
                                            intentional, documented contract change)
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = Path(__file__).with_name("fabric_contract.golden.json")
HEADERS = ("Cache-Control", "Vary", "Access-Control-Allow-Origin", "Deprecation")
RUN = {"seed": "12345", "playback_duration_seconds": 3600, "map": {"osm_file": "tests/fixtures/roads.osm.xml"}}

# Reads that must behave identically before a run and during one.
READS = """/health /api/v1 /api/v1/system/health /api/v1/system/info /api/v1/system/status
/api/v1/system/endpoints /api/v1/system/map-status /api/v1/system/source /api/v1/system/backpressure
/api/v1/system/ui-config /api/v1/system/observer /api/v1/system/narrator /api/v1/playback/status
/api/v1/world/status /api/v1/control/history /api/v1/view/run /api/v1/view/config /api/v1/view/manifest
/api/v1/view/topology /api/v1/topology /api/v1/view/network /api/v1/view/map/full /api/v1/view/snapshot
/api/v1/view/global /api/v1/view/world /api/v1/view/all /api/v1/view/global.json /api/v1/view/nodes
/api/v1/view/nodes/0 /api/v1/view/nodes/999999 /api/v1/view/edges /api/v1/view/edges/0 /api/v1/view/places
/api/v1/places /api/v1/view/place-kinds /api/v1/view/stops /api/v1/view/traffic /api/v1/view/weather
/api/v1/view/buildings /api/v1/view/bus-stops /api/v1/view/signals /api/v1/view/events /api/v1/view/metrics
/api/v1/view/incidents /api/v1/view/congestion /api/v1/view/event-queue /api/v1/view/event-queue?view=history
/api/v1/view/event-queue?view=bad /api/v1/view/nodes?limit=0 /api/v1/news /api/v1/news?since_news_id=-1
/api/v1/view/logs/system /api/v1/view/logs/events /api/v1/view/logs/api /api/v1/view/stream /api/v1/news/stream
/ /index.html /no/such/route""".split()

# Writes, in order, against a running world. Each carries the body and headers it
# sends, so refusals are part of the contract as much as successes.
WRITES = [
    ("POST", "/api/v1/playback/start", RUN, {}),
    ("POST", "/api/v1/playback/prepare", RUN, {"X-DSTNS-Operator": "wrong"}),
    ("POST", "/api/v1/playback/pause", {}, {}),
    ("POST", "/api/v1/playback/play", {}, {"Origin": "https://evil.example"}),
    ("POST", "/api/v1/playback/play", {}, {"Origin": "null"}),
    ("GET", "/health", None, {"Host": "evil.example"}),
    ("POST", "/api/v1/playback/play", {}, {}),
    ("POST", "/api/v1/playback/pause", {}, {}),
    ("POST", "/api/v1/playback/seek", {"target_time": 60}, {}),
    ("POST", "/api/v1/playback/seek", {"target_time": 90000}, {}),
    ("POST", "/api/v1/playback/seek", {}, {}),
    ("POST", "/api/v1/playback/step", {"seconds": 1}, {}),
    ("POST", "/api/v1/playback/step", {"seconds": 0}, {}),
    ("PUT", "/api/v1/control/tick-rate", {"tick_rate": 1}, {}),
    ("PUT", "/api/v1/control/tick-rate", {"tick_rate": "fast"}, {}),
    ("POST", "/api/v1/control/day", {"day": 1}, {}),
    ("PUT", "/api/v1/control/modules/news", {"enabled": True}, {}),
    ("POST", "/api/v1/control/modules/news/enable", {}, {}),
    ("POST", "/api/v1/control/events/weather", {"epicenter_node": 0}, {}),
    ("POST", "/api/v1/control/events/weather", {"epicenter_node": 0, "duration_virtual_minutes": 0}, {}),
    ("POST", "/api/v1/control/events/traffic", {"target": {"type": "edge", "id": 0}, "congestion_pressure": 0.5}, {}),
    ("POST", "/api/v1/control/events/traffic", {"target": {"type": "node", "id": 0}, "congestion_pressure": 0.5}, {}),
    ("POST", "/api/v1/control/events/surge", {"node_id": 0}, {}),
    ("PUT", "/api/v1/control/edges/0", {"speed_multiplier": 0.5}, {}),
    ("POST", "/api/v1/control/edges/0/override", {"closed": False}, {}),
    ("POST", "/api/v1/control/edges/4294967297/override", {}, {}),
    ("POST", "/api/v1/control/transit/route", {}, {}),
    ("POST", "/api/v1/control/undo", {"count": 1}, {}),
    ("POST", "/api/v1/control/undo", {"count": -1}, {}),
    ("POST", "/api/v1/control/redo", {"count": 1}, {}),
    ("POST", "/api/v1/system/backpressure", {"virtual_lag_s": 0, "client_frame_s": 0.016, "since_poll_s": 0}, {}),
    ("POST", "/api/v1/playback/pause", "{not json", {}),
    ("POST", "/api/v1/playback/reset", {}, {}),
    ("POST", "/stop", {}, {}),
    ("OPTIONS", "/api/v1/playback/pause", None, {"Origin": "https://evil.example"}),
    ("POST", "/terminate", {}, {}),
]


def shape(value, depth=0):
    """A value's structure: object keys and types, arrays by their first item."""
    if isinstance(value, dict):
        return {key: shape(value[key], depth + 1) for key in sorted(value)} if depth < 6 else "object"
    if isinstance(value, list):
        return [shape(value[0], depth + 1)] if value and depth < 6 else []
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "null"


def mismatches(recorded, current, where):
    """What the current shape lost against the recorded one. Additions are fine."""
    if recorded == "null" or current == "null":  # Optional until a value exists.
        return []
    if isinstance(recorded, dict):
        if not isinstance(current, dict):
            return [] if recorded == {} else [f"{where}: was an object, now {current}"]
        return [problem for key, value in recorded.items()
                for problem in ([f"{where}.{key}: removed"] if key not in current
                                else mismatches(value, current[key], f"{where}.{key}"))]
    if isinstance(recorded, list):
        if not isinstance(current, list):
            return [f"{where}: was an array, now {current}"]
        return mismatches(recorded[0], current[0], f"{where}[]") if recorded and current else []
    return [] if recorded == current else [f"{where}: was {recorded}, now {current}"]


def main():
    record = "--record" in sys.argv
    with tempfile.TemporaryDirectory(prefix="dstns-contract-") as tmp:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        server = subprocess.Popen(
            [os.environ.get("DSTNS_SERVER", str(ROOT / "build/dstns_server")), "--host", "127.0.0.1", "--port", str(port),
             "--logs", tmp, "--map-cache", "keep"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        operator = {}

        def call(method, route, data=None, headers=None):
            sent = {"Content-Type": "application/json", **(headers or {})}
            payload = data if isinstance(data, str) else None if data is None else json.dumps(data)
            request = urllib.request.Request(f"http://127.0.0.1:{port}{route}", method=method, headers=sent,
                                             data=None if payload is None else payload.encode())
            try:
                response = urllib.request.urlopen(request, timeout=60)
            except urllib.error.HTTPError as error:
                response = error
            except OSError as error:
                raise AssertionError(f"{method} {route}: {error}") from error
            raw = response.read()
            type_ = response.headers.get("Content-Type", "")
            try:
                # The two streams wrap JSON in one server-sent event.
                body = json.loads(raw.decode().split("data: ", 1)[1]) if "event-stream" in type_ else json.loads(raw)
            except (ValueError, IndexError):
                body = "text"
            return {"status": response.status, "type": type_, "body": shape(body),
                    "headers": {name: response.headers[name] for name in HEADERS if response.headers[name]}}

        def wait_for(predicate, what):
            end = time.monotonic() + 20
            while time.monotonic() < end:
                try:
                    if predicate():
                        return
                except (OSError, AssertionError):
                    pass  # Not listening yet, or still starting the run.
                time.sleep(0.05)
            raise AssertionError(f"timed out waiting for {what}")

        observed = {}
        try:
            wait_for(lambda: call("GET", "/health")["status"] == 200, "the server")
            token = (Path(tmp) / "operator.token").read_text().strip()
            for route in READS:
                observed[f"idle GET {route}"] = call("GET", route)
            # The operator's credential, and its absence, are both contract.
            observed["POST /api/v1/playback/start without credential"] = call("POST", "/api/v1/playback/start", RUN)
            for index, (method, route, data, headers) in enumerate(WRITES):
                if route == "/api/v1/playback/start":
                    headers = {"X-DSTNS-Operator": token}
                if route == "/api/v1/playback/pause" and index == 2:
                    wait_for(lambda: call("GET", "/api/v1/view/snapshot")["status"] == 200
                             and json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/playback/status", timeout=5).read())["data"]["lifecycle"] == "RUNNING",
                             "the run to start")
                    for route_read in READS:
                        observed[f"running GET {route_read}"] = call("GET", route_read)
                observed[f"{index:02d} {method} {route} {json.dumps(data)} {sorted(headers) if headers else ''}"] = call(method, route, data, headers)
        finally:
            server.terminate()
            server.wait(timeout=10)

    if record:
        GOLDEN.write_text(json.dumps(observed, indent=0, sort_keys=True) + "\n")
        print(f"Recorded {len(observed)} calls to {GOLDEN.name}")
        return 0

    golden = json.loads(GOLDEN.read_text())
    problems = []
    for name, expected in golden.items():
        got = observed.get(name)
        if got is None:
            problems.append(f"{name}: not exercised")
            continue
        if got["status"] != expected["status"]:
            problems.append(f"{name}: status was {expected['status']}, now {got['status']}")
        if got["type"] != expected["type"]:
            problems.append(f"{name}: content type was {expected['type']}, now {got['type']}")
        for header, value in expected["headers"].items():
            if got["headers"].get(header) != value:
                problems.append(f"{name}: header {header} was {value}, now {got['headers'].get(header)}")
        problems += mismatches(expected["body"], got["body"], name)
    for problem in problems:
        print(problem)
    print(f"{len(golden)} recorded calls, {len(problems)} differences")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
