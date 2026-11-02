#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The launcher starting a real application with a real engine: the engine comes up, the application
is started, and only once it says it is ready does the simulation start. Then it stops with the launcher."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
APP = "org.example.hello"
SLOW = "org.example.slow"
FIXTURE = "data/fixtures/real_network.osm.xml"


def main():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "DSTNS_API_PORT": str(port), "DSTNS_LOGS_DIR": tmp, "DSTNS_APPS_FILE": str(Path(tmp) / "apps.json"), "DSTNS_SEED_DB": str(Path(tmp) / "seeds.db")}
        env.pop("DSTNS_OPERATOR_TOKEN", None)

        def launcher(*args, check=True):
            done = subprocess.run(["python3", "launcher.py", *args], cwd=ROOT, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
            assert not check or done.returncode == 0, done.stdout + done.stderr
            return done

        def get(route, headers=None):
            request = urllib.request.Request(base + route, headers=headers or {})
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                return error.code, {}
            except OSError:
                return 0, {}

        hello = "python3 Fabric/examples/hello_app.py --url {url}"
        launcher("apps", "add", APP, "--command", hello, "--name", "Hello", "--required", "--timeout", "30")
        # One that takes a while, so that the wait can be seen: it reports ready only after three seconds.
        script = Path(tmp) / "slow.py"
        script.write_text(SLOW_APP)
        launcher("apps", "add", SLOW, "--command", f"python3 {script} --url {{url}}", "--name", "Slow", "--timeout", "30")
        listed = launcher("apps", "list").stdout
        assert APP in listed and SLOW in listed, listed
        assert launcher("apps", "doctor").returncode == 0

        process = subprocess.Popen(["python3", "launcher.py", "start", "--no-open", "--osm-file", FIXTURE, "--seed", "10775", "--duration", "600", "--apps", f"{APP},{SLOW}"],
                                   cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        try:
            # The simulation must not have started while any application was not ready.
            order = []
            seen_plan = False
            operator = None
            end = time.monotonic() + 90
            while time.monotonic() < end:
                if operator is None and (Path(tmp) / "operator.token").exists():
                    operator = {"X-DSTNS-Operator": (Path(tmp) / "operator.token").read_text().strip()}
                code, status = get("/api/v1/fabric/engine/status")
                lifecycle = (status.get("data") or {}).get("lifecycle")
                states = {}
                if operator:
                    for app in (APP, SLOW):
                        health = get(f"/api/v1/fabric/apps/{app}/health", operator)
                        states[app] = (health[1].get("data") or {}).get("state")
                    plan = get("/api/v1/fabric/state?since=0")[1].get("data", {}).get("launch_plan")
                    seen_plan = seen_plan or bool(plan and plan.get("apps"))
                if lifecycle and lifecycle != "IDLE":
                    order.append((lifecycle, dict(states)))
                    break
                time.sleep(0.05)
            assert order, "the simulation never started"
            lifecycle, states = order[0]
            assert states == {APP: "active", SLOW: "active"}, f"it started with {states}"
            assert seen_plan, "the observer was told what was being started"
            # The plan stays while they run, which is how a reloaded application comes back as itself.
            running = get("/api/v1/fabric/state?since=0")[1]["data"]["launch_plan"]
            assert running and {entry["state"] for entry in running["apps"]} == {"ready"}, running

            # A person reloads one: its link ends, the launcher starts it again, and it comes back as itself.
            post = lambda route: urllib.request.urlopen(urllib.request.Request(base + route, method="POST", data=b"{}", headers={"Content-Type": "application/json", **operator}), timeout=5)  # noqa: E731
            assert json.load(post(f"/api/v1/fabric/apps/{APP}/reload"))["data"]["managed"] is True
            back = None
            for _ in range(150):
                health = get(f"/api/v1/fabric/apps/{APP}/health", operator)[1].get("data") or {}
                if health.get("state") == "active" and (health.get("uptime_s") or 99) < 30:
                    back = health
                    break
                time.sleep(0.1)
            assert back, "it came back after being reloaded"

            # The launcher can see them, and the application is really running under it.
            status = launcher("apps", "status").stdout
            assert APP in status and "active" in status, status
            assert "Intact" in launcher("fabric", "status").stdout

            # Failing to start a required one stops the run from starting, with the reason.
            launcher("apps", "add", "org.example.broken", "--command", "python3 -c 'import sys; print(\"nothing here\"); sys.exit(4)'", "--required")
        finally:
            os.killpg(process.pid, signal.SIGTERM)
            output, _ = process.communicate(timeout=20)
        assert "Hello ready" in output and "Slow ready" in output and "Reloading Hello" in output, output
        # They went with the launcher, whose server has stopped.
        for _ in range(40):
            if get("/health")[0] == 0:
                break
            time.sleep(0.2)
        assert get("/health")[0] == 0, "the server stopped"
        assert subprocess.run(["pgrep", "-f", str(script)], capture_output=True).returncode == 1, "the application stopped"

        broken = subprocess.run(["python3", "launcher.py", "start", "--no-open", "--osm-file", FIXTURE, "--seed", "10775", "--apps", "org.example.broken"],
                                cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
        assert broken.returncode != 0, broken.stdout
        assert "is required" in broken.stdout + broken.stderr and "status 4" in broken.stdout + broken.stderr, broken.stdout + broken.stderr
    print("launcher apps ok")


SLOW_APP = """
import argparse, json, os, signal, time, urllib.request
url = argparse.ArgumentParser()
url.add_argument("--url")
url = url.parse_args().url
def call(method, route, data=None, token=None):
    request = urllib.request.Request(url + route, method=method, data=None if data is None else json.dumps(data).encode(), headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
    return json.load(urllib.request.urlopen(request, timeout=10)).get("data")
token = call("POST", "/api/v1/fabric/apps", {"id": "org.example.slow", "name": "Slow", "version": "1.0.0"})["token"]
time.sleep(3)
call("PUT", "/api/v1/fabric/apps/org.example.slow/state", {"state": "active"}, token)
signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
while True:
    time.sleep(1)
    call("POST", "/api/v1/fabric/apps/org.example.slow/heartbeat", {}, token)
"""


if __name__ == "__main__":
    main()
