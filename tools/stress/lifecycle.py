#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic
"""Stress the server's state machines.

Starts a private dstns_server on a free port, with the bundled district, and sends it paced random requests from
several clients at once: starts, prepares, stops, resets, new worlds (staged, confirmed, discarded), jumps, steps,
pause and play, storms, traffic, surges, road overrides, undo and redo. It then requires that:

  * no request was answered with a 5xx, or not answered at all;
  * the server logged no ERROR: every lifecycle and world-job transition was one its tables allow
    (docs/design/state-machines.md), and nothing failed inside it;
  * the server is still healthy, and a clean start afterwards runs, plays and jumps.

Refusals (4xx) are expected: a step during a jump, a new world while one is being made. Standard library only.

    python3 tools/stress/lifecycle.py [--server build/dstns_server] [--ops 800] [--clients 4] [--seed 11]
"""
import argparse
import collections
import json
import os
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURE = os.path.join(ROOT, "data", "fixtures", "real_network.osm.xml")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--server", default=os.path.join(ROOT, "build", "dstns_server"))
    parser.add_argument("--ops", type=int, default=800)
    parser.add_argument("--clients", type=int, default=4)
    parser.add_argument("--seed", type=int, default=11)
    args = parser.parse_args()
    rng = random.Random(args.seed)

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    logs = tempfile.mkdtemp(prefix="dstns-stress-")
    environment = dict(os.environ, DSTNS_DYNAMIC_FASTBOOT="0", DSTNS_NARRATOR="off")
    server = subprocess.Popen([args.server, "--port", str(port), "--logs", logs, "--map-cache", "keep"], cwd=ROOT, env=environment,
                              stdout=subprocess.DEVNULL, stderr=open(os.path.join(logs, "stderr.txt"), "w"))
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(200):
            try:
                urllib.request.urlopen(base + "/health", timeout=1)
                break
            except OSError:
                time.sleep(0.05)
        else:
            print("the server did not answer /health")
            return 1
        token = open(os.path.join(logs, "operator.token")).read().strip()

        def call(method, path, body=None, operator=False):
            data = json.dumps(body if body is not None else {}).encode() if method != "GET" else None
            headers = {"content-type": "application/json", "X-DSTNS-Host": "observer"}
            if operator:
                headers["X-DSTNS-Operator"] = token
            try:
                with urllib.request.urlopen(urllib.request.Request(base + path, data=data, method=method, headers=headers), timeout=120) as r:
                    return r.status, json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                try:
                    return e.code, json.loads(e.read() or b"{}")
                except ValueError:
                    return e.code, {}
            except OSError as e:
                return 0, {"exception": str(e)}

        engine = "/api/v1/fabric/engine"

        def start():
            return call("POST", engine + "/start", {"seed": str(rng.randint(1, 10**9)), "playback_duration_seconds": rng.choice([60, 600, 3600]),
                                                     "map": {"osm_file": FIXTURE}}, operator=True)

        operations = {
            "start": (5, start),
            "prepare": (2, lambda: call("POST", engine + "/prepare", {"seed": str(rng.randint(1, 10**9)), "map": {"osm_file": FIXTURE}}, operator=True)),
            "stop": (3, lambda: call("POST", engine + "/stop")),
            "reset": (2, lambda: call("POST", engine + "/reset")),
            "regenerate": (4, lambda: call("POST", "/api/v1/world/regenerate")),
            "stage": (5, lambda: call("POST", "/api/v1/world/regenerate", {"stage": True})),
            "commit": (5, lambda: call("POST", "/api/v1/world/regenerate/commit")),
            "discard": (4, lambda: call("POST", "/api/v1/world/regenerate/discard")),
            "seek": (8, lambda: call("POST", engine + "/seek", {"target_time": rng.randint(0, 86399), "play": rng.random() < 0.4})),
            "pause": (5, lambda: call("POST", engine + "/pause")),
            "play": (5, lambda: call("POST", engine + "/play")),
            "step": (4, lambda: call("POST", engine + "/step", {"seconds": rng.choice([1, 60, 3600])})),
            "rate": (4, lambda: call("PUT", engine + "/tick-rate", {"tick_rate": rng.choice([0.25, 0.5, 1, 2, 5, 10])})),
            "weather": (3, lambda: call("POST", engine + "/events/weather", {"epicenter_node": rng.randrange(1000), "intensity": rng.random(),
                                                                             "radius_m": rng.randint(50, 900), "duration_virtual_minutes": rng.randint(1, 240)})),
            "traffic": (3, lambda: call("POST", engine + "/events/traffic", {"target": {"type": "edge", "id": rng.randrange(2000)}, "congestion_pressure": rng.random()})),
            "surge": (2, lambda: call("POST", engine + "/events/surge", {"node_id": rng.randrange(1000), "factor": rng.uniform(0.5, 10), "radius_m": rng.randint(50, 3000)})),
            "edge": (3, lambda: call("PUT", f"{engine}/edges/{rng.randrange(2000)}", {"speed_multiplier": rng.uniform(0, 2), "capacity_multiplier": rng.uniform(0, 2),
                                                                                      "closed": rng.random() < 0.2})),
            "undo": (2, lambda: call("POST", "/api/v1/control/undo")),
            "redo": (2, lambda: call("POST", "/api/v1/control/redo")),
            "status": (6, lambda: call("GET", engine + "/status")),
            "snapshot": (4, lambda: call("GET", "/api/v1/view/snapshot")),
            "world": (4, lambda: call("GET", "/api/v1/world/status")),
        }
        names = list(operations)
        weights = [operations[name][0] for name in names]
        codes = collections.Counter()
        failures = []
        lock = threading.Lock()

        def client():
            for _ in range(args.ops // args.clients):
                with lock:
                    name = rng.choices(names, weights)[0]
                    pause = rng.uniform(0, 0.3)
                status, body = operations[name][1]()
                with lock:
                    codes[(name, status)] += 1
                    if status >= 500 or status == 0:
                        failures.append(f"{name}: {status} {json.dumps(body)[:200]}")
                time.sleep(pause)

        start()
        time.sleep(3)
        began = time.time()
        clients = [threading.Thread(target=client) for _ in range(args.clients)]
        for c in clients:
            c.start()
        for c in clients:
            c.join()
        time.sleep(5)

        # What the server itself reported: any ERROR is a transition outside its tables, or a fault.
        log = open(os.path.join(logs, "system.log"), errors="replace").read().splitlines()
        errors = collections.Counter(line.split("] ", 2)[-1] if "] " in line else line for line in log if "[ERROR]" in line)
        transitions = {line.split("[lifecycle] ")[1].split(" run=")[0] for line in log if "[lifecycle] " in line and " -> " in line}

        # After the storm, the ordinary path still works.
        call("POST", engine + "/stop")
        time.sleep(1)
        call("POST", engine + "/reset")
        clean = start()[0]
        time.sleep(5)
        call("POST", engine + "/play")
        time.sleep(2)
        after = call("GET", engine + "/status")[1].get("data", {}).get("lifecycle")
        jump = call("POST", engine + "/seek", {"target_time": 43200})[0]
        health = call("GET", "/health")[0]

        accepted = sum(n for (_, status), n in codes.items() if 200 <= status < 300)
        refused = sum(n for (_, status), n in codes.items() if 400 <= status < 500)
        print(f"{sum(codes.values())} requests from {args.clients} clients in {time.time() - began:.0f} s: {accepted} accepted, {refused} refused (4xx), "
              f"{len(failures)} failed; {len(transitions)} kinds of lifecycle transition")
        for line in failures[:10]:
            print("  failed:", line)
        for line, count in errors.most_common(10):
            print(f"  server ERROR x{count}: {line}")
        if server.poll() is not None:
            print(f"  the server exited with status {server.returncode}: {open(os.path.join(logs, 'stderr.txt')).read()[:3500]}")
            print("  last log lines:", *log[-6:], sep="\n    ")
        ok = not failures and not errors and health == 200 and clean == 202 and after in ("RUNNING", "PAUSED", "COMPLETED") and jump == 200
        if not ok:
            print(f"  health {health}, clean start {clean}, then {after}, jump {jump}")
        print("Lifecycle stress: " + ("no server error, no transition outside the tables, and a clean start afterwards runs" if ok else "FAILED"))
        return 0 if ok else 1
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main())
