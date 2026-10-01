#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

import gzip
"""Comprehensive end-to-end API test suite for DSTNS."""
import argparse
import json
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
import os

def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

def call(base: str, path: str, method: str = "GET", payload: dict | list | None = None) -> tuple[int, dict]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json", "X-DSTNS-Operator": os.environ.get("DSTNS_OPERATOR_TOKEN", "")})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            body = json.load(exc)
        except Exception:
            body = {"error": exc.read().decode("utf-8", errors="replace")}
        return exc.code, body

def wait_for_preparation(base: str) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        code, status = call(base, "/api/v1/playback/status")
        assert code == 200, status
        lifecycle = status["data"]["lifecycle"]
        if lifecycle != "PREPARING":
            return status
        time.sleep(0.02)
    raise AssertionError("world preparation did not finish")

def wait_health(base: str, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            _, err = process.communicate()
            raise RuntimeError(f"Server died during startup: {err}")
        try:
            status, res = call(base, "/health")
            if status == 200 and res.get("ok"):
                return
        except Exception:
            time.sleep(0.05)
    raise RuntimeError("Server health check timed out")

def main():
    root = Path(__file__).resolve().parent.parent.parent
    default_server = root / "build" / "dstns_server"
    parser = argparse.ArgumentParser(description="DSTNS API Test Suite")
    parser.add_argument("--server", default=str(default_server), help="Path to dstns_server (defaults to build/dstns_server)")
    parser.add_argument("--url", default=None, help="Connect to running server base URL (e.g. http://127.0.0.1:8090)")
    args = parser.parse_args()

    if args.url:
        base = args.url.rstrip("/")
        print(f"[test] Running API test suite against running server on {base}...")
        process = None
        logs = None
    else:
        if not Path(args.server).exists():
            raise FileNotFoundError(f"DSTNS server binary not found at {args.server}. Run cmake --build build first.")
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        print(f"[test] Spawning test server on {base}...")
        tmp_dir = tempfile.TemporaryDirectory(prefix="dstns-api-test-")
        logs = tmp_dir.name
        process = subprocess.Popen([args.server, "--host", "127.0.0.1", "--port", str(port), "--logs", logs, "--map-cache", "keep"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    assertions = 0
    try:
        if process:
            wait_health(base, process)
            os.environ["DSTNS_OPERATOR_TOKEN"] = (Path(logs) / "operator.token").read_text().strip()

            # 1. Health Endpoints
            code, h1 = call(base, "/health")
            assert code == 200 and h1["ok"] is True and ("Deterministic" in h1["product"] or "DSTNS" in h1["product"])
            assertions += 1

            code, h2 = call(base, "/api/v1/system/health")
            assert code == 200 and h2["ok"] is True
            assertions += 1

            # 2. Initial Idle Status
            code, st = call(base, "/api/v1/playback/status")
            assert code == 200 and st["data"]["lifecycle"] == "IDLE"
            assertions += 1

            # 3. No map before a run. The seed selects a real city district that
            # is downloaded on demand, so the server must not compile a scenario
            # (and must not hit the network) merely because it booted.
            code, initial_map = call(base, "/api/v1/view/topology")
            assert code == 200 and not initial_map["data"]
            assertions += 1

            # 3b. Validation: Reject invalid start requests

            code, err = call(base, "/api/v1/playback/start", "POST", {"tick_rate": -1})
            assert code == 400 and err["error"]["code"] == "INVALID_REQUEST"
            assertions += 1

            code, err = call(base, "/api/v1/control/transit/route", "POST", {"bus_id": "MISSING-NODES"})
            assert code == 410 and err["error"]["code"] == "TRANSIT_API_RETIRED"
            assert "no longer supported" in err["error"]["message"]
            code, err = call(base, "/api/v1/control/events/weather", "POST", {"epicenter_node": "not-a-number"})
            assert code == 400 and err["error"]["code"] == "INVALID_FIELD_TYPE"
            assert "number" in err["error"]["message"]
            assertions += 4

            # 3a. The launcher waits for the observer before asking for a world.
            code, observer = call(base, "/api/v1/system/observer")
            assert code == 200 and observer["data"]["loaded"] is False, observer
            urllib.request.urlopen(base + "/").read()
            code, observer = call(base, "/api/v1/system/observer")
            assert code == 200 and observer["data"]["loaded"] is True and observer["data"]["loads"] >= 1
            assertions += 2

            # 3b. The seed is a number, in whichever form it is given.
            decimal_start = dict(req_start_template := {
                "seed": "1311768467294899695",
                "playback_duration_seconds": 3600,
                "day": 0,
                "map": {"osm_file": "tests/fixtures/roads.osm.xml", "max_nodes": 50},
            })
            code, started = call(base, "/api/v1/playback/start", "POST", decimal_start)
            assert code == 202 and started["data"]["lifecycle"] == "PREPARING", started
            seeded = wait_for_preparation(base)
            assert seeded["seed"] == "1311768467294899695", seeded["seed"]
            # 0x1234567890abcdef is the same number written in hexadecimal.
            assert seeded["global_seed"] == "0x00000000000000001234567890abcdef"
            assertions += 3
            del req_start_template
            # Leave the core idle again so the run below starts from nothing.
            call(base, "/api/v1/playback/stop", "POST", {})
            call(base, "/api/v1/playback/reset", "POST", {})

            # 4. Start Simulation
            req_start = {
                "seed": "0x123456789ABCDEF0",
                "playback_duration_seconds": 3600,
                "day": 0,
                "map": {"osm_file": "tests/fixtures/roads.osm.xml", "max_nodes": 50},
                "tick_rate": 1.0,
                "modules": {
                    "traffic": True,
                    "signals": True,
                    "buildings": True,
                    "dws": True,
                    "flooding": True,
                    "news": True
                },
                "dws": {"frequency": 4}
            }
            code, start = call(base, "/api/v1/playback/start", "POST", req_start)
            assert code == 202 and start["data"]["lifecycle"] == "PREPARING"
            start = wait_for_preparation(base)
            assert start["data"]["lifecycle"] == "RUNNING"
            assertions += 1

            # The map now exists, is geographically spread, and reports both the
            # metre projection and the place it was cut from.
            code, started_map = call(base, "/api/v1/view/topology")
            assert code == 200 and len(started_map["data"]["nodes"]) >= 9
            assert len({n["position"]["lon"] for n in started_map["data"]["nodes"]}) > 2
            assert len({n["position"]["lat"] for n in started_map["data"]["nodes"]}) > 2
            assert started_map["data"]["projection"]["units"] == "metres"
            assert "location" in started_map["data"]
            assertions += 5

            # 5. Double start conflict
            code, err = call(base, "/api/v1/playback/start", "POST", req_start)
            assert code == 409 and err["error"]["code"] == "LIFECYCLE_CONFLICT"
            assertions += 1

            # 6. Pause & Resume
            code, p = call(base, "/api/v1/playback/pause", "POST", {})
            assert code == 200 and p["lifecycle"] == "PAUSED"
            assertions += 1

            code, _ = call(base, "/api/v1/playback/seek", "POST", {"target_time": "00:02:17"})
            assert code == 200
            code, _ = call(base, "/api/v1/playback/seek", "POST", {"target_time": "00:50:01"})
            assert code == 200
            code, checkpoint_status = call(base, "/api/v1/playback/status")
            assert code == 200 and checkpoint_status["data"]["checkpoint_count"] == 4
            assertions += 3

            # 7. Topology & Map Views
            code, topo = call(base, "/api/v1/view/topology")
            assert code == 200 and len(topo["data"]["nodes"]) > 0 and len(topo["data"]["edges"]) > 0
            assert "bounds" in topo["data"] and "min_lat" in topo["data"]["bounds"]
            assertions += 2

            # Place markers carry their canonical demand type (or null).
            assert all("demand_type" in f for f in topo["data"]["features"])
            assert {f["demand_type"] for f in topo["data"]["features"]} <= {None, "school", "office", "mall", "store"}
            assertions += 1

            code, net = call(base, "/api/v1/view/network")
            assert code == 200 and net["data"]["graph_hash"] == topo["data"]["graph_hash"]
            assertions += 1

            code, full_map = call(base, "/api/v1/view/map/full")
            assert code == 200 and full_map["data"]["topology_revision"] == 1
            assertions += 1

            # 8. Dynamic Snapshot
            code, snap = call(base, "/api/v1/view/snapshot")
            assert code == 200 and len(snap["data"]["nodes"]) == len(topo["data"]["nodes"])
            assert "active_weather" in snap["data"] and "event_stack" in snap["data"] and "active_incidents" in snap["data"]
            assertions += 3

            # 8b. Global View Comprehensive Endpoint
            code, gv = call(base, "/api/v1/view/global")
            assert code == 200 and gv["ok"] is True
            d = gv["data"]
            assert "metrics" in d and d["metrics"]["total_nodes"] == len(topo["data"]["nodes"])
            assert d["metrics"]["total_edges"] == len(topo["data"]["edges"])
            assert "bounds" in d and "center_lat" in d["bounds"]
            assert "nodes" in d and len(d["nodes"]) == len(topo["data"]["nodes"])
            assert "edges" in d and len(d["edges"]) == len(topo["data"]["edges"])
            n0 = d["nodes"][0]
            for field in ["id", "osm_node_id", "position", "degree", "flood_susceptibility", "drainage", "roles", "dynamic"]:
                assert field in n0, f"missing {field} in node"
            e0 = d["edges"][0]
            for field in ["id", "from", "to", "reverse_twin", "road_class", "lanes", "length_m", "free_speed_mps", "geometry", "dynamic"]:
                assert field in e0, f"missing {field} in edge"
            for dyn in ["demand_vph", "effective_capacity_vph", "effective_speed_mps", "vehicle_count", "congestion", "flood", "closed"]:
                assert dyn in e0["dynamic"], f"missing {dyn} in edge dynamic"
            code, gv_world = call(base, "/api/v1/view/world")
            assert code == 200 and gv_world["ok"] is True
            assertions += 7

            synthetic_reverse = next(
                edge for edge in d["edges"]
                if edge["synthetic_reverse"]
                and not any(
                    candidate["from"] == edge["from"]
                    and candidate["to"] == edge["to"]
                    and not candidate["synthetic_reverse"]
                    for candidate in d["edges"]
                )
            )
            code, invalid_route = call(base, "/api/v1/control/transit/route", "POST", {
                "bus_id": "ONEWAY-REVERSE",
                "nodes": [synthetic_reverse["from"], synthetic_reverse["to"]]
            })
            assert code == 410 and invalid_route["ok"] is False
            assert synthetic_reverse["dynamic"]["effective_capacity_vph"] == 0.0
            assert synthetic_reverse["dynamic"]["effective_speed_mps"] == 0.0
            reverse_twin = d["edges"][synthetic_reverse["reverse_twin"]]
            code, valid_route = call(base, "/api/v1/control/transit/route", "POST", {
                "bus_id": "ONEWAY-FORWARD",
                "nodes": [reverse_twin["from"], reverse_twin["to"]]
            })
            assert code == 410 and valid_route["error"]["code"] == "TRANSIT_API_RETIRED"
            assertions += 4

            # 9. Node & Edge Detailed Views
            code, nodes = call(base, "/api/v1/view/nodes?offset=0&limit=10")
            assert code == 200 and len(nodes["data"]["items"]) <= 10
            assertions += 1

            code, node_0 = call(base, "/api/v1/view/nodes/0")
            assert code == 200 and node_0["data"]["items"][0]["id"] == 0
            assertions += 1

            code, edges = call(base, "/api/v1/view/edges?offset=0&limit=10")
            assert code == 200 and len(edges["data"]["items"]) <= 10
            assertions += 1

            code, edge_0 = call(base, "/api/v1/view/edges/0")
            assert code == 200 and edge_0["data"]["items"][0]["id"] == 0
            assertions += 1

            # 10. Entity Catalogs
            for cat in ("traffic", "weather", "buildings", "bus-stops", "signals", "events", "metrics", "incidents"):
                code, c_res = call(base, f"/api/v1/view/{cat}")
                assert code == 200 and ("items" in c_res["data"] or "vehicle_count" in c_res["data"])
                assertions += 1

            code, incs = call(base, "/api/v1/view/incidents")
            assert code == 200 and len(incs["data"]["items"]) >= 4, "minimum 4 incidents generated"
            assertions += 1

            # 11. Manifest
            code, man = call(base, "/api/v1/view/manifest")
            assert code == 200 and man["data"]["product"] == "DSTNS" and man["data"]["scenario_hash"]
            assertions += 1

            # 12. Tick Rate Control (Valid & Invalid)
            code, tick = call(base, "/api/v1/control/tick-rate", "PUT", {"tick_rate": 0.5})
            expected_rate = 86_400 / req_start["playback_duration_seconds"] * 0.5
            assert code == 200 and tick["tick_rate"] == 0.5 and tick["target_virtual_rate"] == expected_rate
            assertions += 1

            code, err = call(base, "/api/v1/control/tick-rate", "PUT", {"tick_rate": 0.0})
            assert code == 400
            assertions += 1

            code, err = call(base, "/api/v1/control/tick-rate", "PUT", {"tick_rate": 150.0})
            assert code == 400
            assertions += 1

            code, tick = call(base, "/api/v1/control/tick-rate", "PUT", {"tick_rate": 5.0})
            assert code == 200 and tick["requested_tick_rate"] == 5.0, "5x is the highest offered rate"
            assertions += 1

            code, err = call(base, "/api/v1/control/tick-rate", "PUT", {"tick_rate": 5.5})
            assert code == 400, "rates above 5x are rejected"
            assertions += 1

            code, tick = call(base, "/api/v1/control/tick-rate", "PUT", {"tick_rate": 0.5})
            assert code == 200

            # 13. Day Override (Valid & Invalid)
            code, day = call(base, "/api/v1/control/day", "POST", {"day": 1})
            assert code == 200 and day["day"] == 1
            assertions += 1

            code, err = call(base, "/api/v1/control/day", "POST", {"day": 5})
            assert code == 400
            assertions += 1

            # 14. Module Enable / Disable
            for mod in ("dws", "traffic", "signals", "buildings", "flooding", "news"):
                code, off = call(base, f"/api/v1/control/modules/{mod}", "PUT", {"enabled": False})
                assert code == 200 and off["enabled"] is False
                code, on = call(base, f"/api/v1/control/modules/{mod}", "PUT", {"enabled": True})
                assert code == 200 and on["enabled"] is True
                assertions += 2

            # 15. Manual Weather Event
            code, weather = call(base, "/api/v1/control/events/weather", "POST", {
                "epicenter_node": 0,
                "intensity": 0.8,
                "radius_m": 700.0,
                "duration_virtual_minutes": 30,
                "flood_gain": 0.6
            })
            assert code == 202 and weather["status"] == "scheduled"
            assertions += 1

            # 16. Road Edge Override
            code, edge_ov = call(base, "/api/v1/control/edges/0", "PUT", {
                "speed_multiplier": 0.5,
                "capacity_multiplier": 0.5,
                "closed": False
            })
            assert code == 200 and edge_ov["edge_id"] == 0
            assertions += 1

            # 17. Undo / Redo & Control History
            code, undo_res = call(base, "/api/v1/control/undo", "POST", {"count": 1})
            assert code == 200 and len(undo_res["undone"]) == 1
            assertions += 1

            code, redo_res = call(base, "/api/v1/control/redo", "POST", {"count": 1})
            assert code == 200 and len(redo_res["redone"]) == 1
            assertions += 1

            code, hist = call(base, "/api/v1/control/history")
            assert code == 200 and len(hist["data"]["commands"]) > 0
            assertions += 1

            # 18. Seek
            code, seek = call(base, "/api/v1/playback/seek", "POST", {"target_time": "15:30:00"})
            assert code == 200 and seek["simulated_seconds"] == 55800 and seek["lifecycle"] == "PAUSED"
            assertions += 1

            # 18b. Step: exact increments that always leave the run paused.
            code, step = call(base, "/api/v1/playback/step", "POST", {"seconds": 60})
            assert code == 200 and step["simulated_seconds"] == 55860 and step["lifecycle"] == "PAUSED"
            assert step["stepped_seconds"] == 60
            code, step = call(base, "/api/v1/playback/step", "POST", {})
            assert code == 200 and step["simulated_seconds"] == 55920, "default step is one minute"
            for bad in (0, -5, 3601):
                code, err = call(base, "/api/v1/playback/step", "POST", {"seconds": bad})
                assert code == 400 and err["error"]["code"] == "INVALID_REQUEST", bad
            assertions += 5

            # 18c. World regeneration: a fresh seed, the operator's configuration,
            # started paused, reported through a pollable job.
            code, status_before = call(base, "/api/v1/playback/status")
            old_run, old_seed = status_before["run_id"], status_before["seed"]
            code, idle = call(base, "/api/v1/world/status")
            assert code == 200 and idle["data"]["enabled"] is True
            code, stale = call(base, "/api/v1/world/regenerate", "POST", {"expected_run_id": "run_elsewhere"})
            assert code == 409 and stale["error"]["code"] == "LIFECYCLE_CONFLICT"
            code, job = call(base, "/api/v1/world/regenerate", "POST", {"expected_run_id": old_run})
            assert code == 202 and job["data"]["seed"] and job["data"]["seed"] != old_seed
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                code, job = call(base, "/api/v1/world/status")
                if job["data"]["state"] != "generating":
                    break
                time.sleep(0.05)
            assert job["data"]["state"] == "ready" and job["data"]["error"] is None, job
            code, status_after = call(base, "/api/v1/playback/status")
            assert status_after["run_id"] == job["data"]["run_id"] != old_run
            assert status_after["seed"] == job["data"]["seed"]
            assert status_after["global_seed"] == job["data"]["seed_hex"]
            # A generated seed is a plain number an operator can read and retype.
            assert status_after["seed"].isdigit() and len(status_after["seed"]) <= 20
            assert status_after["data"]["lifecycle"] == "PAUSED"
            assert status_after["clock"]["virtual_day_seconds"] == 0
            code, topo = call(base, "/api/v1/view/topology")
            assert code == 200 and topo["run_id"] == job["data"]["run_id"] and topo["data"]["edges"]
            assertions += 8
            # Later sections expect a run positioned mid-day, as before.
            code, seek = call(base, "/api/v1/playback/seek", "POST", {"target_time": "15:30:00"})
            assert code == 200 and seek["lifecycle"] == "PAUSED"

            # Rich JSON uses negotiated compression, including its exact media type.
            request = urllib.request.Request(base + "/api/v1/view/topology", headers={"Accept-Encoding": "gzip"})
            with urllib.request.urlopen(request) as compressed:
                assert compressed.headers.get("Content-Encoding") == "gzip"
                assert json.loads(gzip.decompress(compressed.read()))["ok"]
            assertions += 1

            # 19. News API
            code, news = call(base, "/api/v1/news")
            assert code == 200 and len(news["data"]["items"]) > 0
            assertions += 1

            # 20. Log Endpoints
            code, sys_log = call(base, "/api/v1/view/logs/system")
            assert code == 200 and len(sys_log["data"]["lines"]) > 0
            assertions += 1

            code, ev_log = call(base, "/api/v1/view/logs/events")
            assert code == 200 and len(ev_log["data"]["items"]) > 0
            assertions += 1

            code, api_log = call(base, "/api/v1/view/logs/api")
            assert code == 200 and len(api_log["data"]["items"]) > 0
            assertions += 1

            # 21. Stop & Reset
            code, _ = call(base, "/api/v1/playback/play", "POST", {})
            code, stop_res = call(base, "/api/v1/playback/stop", "POST", {})
            assert code == 200 and stop_res["lifecycle"] == "STOPPED"
            assertions += 1

            code, rst = call(base, "/api/v1/playback/reset", "POST", {})
            assert code == 200 and rst["lifecycle"] == "IDLE"
            assertions += 1

            # 22. System Info & SUMO Integration
            # The discoverable place API accepts only complete unsigned integers.
            for route in ["/api/v1/view/places", "/api/v1/view/stops", "/api/v1/view/nodes", "/api/v1/view/edges"]:
                for query in ["offset=-1", "offset=1junk", "limit=0", "limit=nan", "offset=999999999999999999999999999"]:
                    code, invalid = call(base, route + "?" + query)
                    assert code == 400, (route, query, code, invalid)
                    assertions += 1
            code, kinds = call(base, "/api/v1/view/place-kinds")
            assert code == 200 and len(kinds["data"]["items"]) == 18, kinds
            assertions += 1
            code, places = call(base, "/api/v1/view/places?kind=bus_stop&limit=2001")
            assert code == 200 and places["data"]["limit"] == 2000, places
            code, stops = call(base, "/api/v1/view/stops?limit=2000")
            assert code == 200 and stops["data"]["items"] == places["data"]["items"], stops
            assertions += 2
            code, index = call(base, "/api/v1/system/endpoints")
            routes = [(e["method"],e["path"]) for g in index["groups"] for e in g["endpoints"]]
            assert ("GET", "/api/v1/world/status") in routes and ("PUT", "/api/v1/control/edges/{id}/override") in routes
            assertions += 1
            code, sys_info = call(base, "/api/v1/system/info")
            assert code == 200 and ("Deterministic" in sys_info["product"] or "DSTNS" in sys_info["product"]) and "sumo" in sys_info
            assertions += 1

            code, sumo_exp = call(base, "/api/v1/playback/start", "POST", req_start)
            assert code == 202
            wait_for_preparation(base)
            code, sumo_out = call(base, "/api/v1/export/sumo", "POST", {"directory": str(Path(logs) / "sumo_exp")})
            assert code == 200 and sumo_out["data"]["ok"] is True
            assert (Path(logs) / "sumo_exp" / "network.nod.xml").exists()
            assertions += 2

            if sys_info["sumo"]["available"]:
                code, sumo_sim = call(base, "/api/v1/system/sumo-simulate", "POST", {
                    "directory": str(Path(logs) / "sumo_sim"),
                    "begin_s": 0,
                    "end_s": 1800
                })
                assert code == 200 and sumo_sim["data"]["ok"] is True and sumo_sim["data"]["engine"] == "SUMO", (code, sumo_sim)
                assertions += 1

            # 23. Graceful Terminate (only when test process was spawned)
            if process:
                code, term = call(base, "/api/v1/system/terminate", "POST", {})
                assert code == 200
                process.wait(timeout=5)
                assert process.returncode == 0
                assertions += 2

            # 24. SQLite Journal Verification
            if logs:
                db_path = Path(logs) / "runtime.db"
                assert db_path.exists() and db_path.stat().st_size > 0
                assertions += 1

            print(f"DSTNS Exhaustive API Test Suite PASSED: {assertions} assertions verified.")
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=3)
        if "tmp_dir" in locals():
            try:
                tmp_dir.cleanup()
            except Exception:
                pass

if __name__ == "__main__":
    main()
