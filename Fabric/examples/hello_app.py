#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic
"""The smallest whole application: it connects, adds a panel to the interface, says it is
ready, follows the simulation and stays until asked to stop. Standard library only.

    ./launcher apps add org.example.hello --command "python3 Fabric/examples/hello_app.py --url {url}"
    ./launcher start --apps org.example.hello
"""
import argparse
import json
import os
import signal
import time
import urllib.error
import urllib.request

APP = "org.example.hello"
MANIFEST = {
    "id": APP,
    "name": "Hello",
    "version": "1.0.0",
    "description": "The smallest whole application.",
    "capabilities": ["ui.panels", "ui.map-controls", "sim.read", "storage"],
    "lease_s": 30,
}


def main():
    options = argparse.ArgumentParser()
    options.add_argument("--url", default=os.environ.get("DSTNS_URL", "http://127.0.0.1:8090"))
    url = options.parse_args().url.rstrip("/")
    token = [None]

    def call(method, route, data=None):
        request = urllib.request.Request(url + route, method=method, data=None if data is None else json.dumps(data).encode(), headers={"Content-Type": "application/json"})
        if token[0]:
            request.add_header("Authorization", f"Bearer {token[0]}")
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response).get("data")

    base = f"/api/v1/fabric/apps/{APP}"
    token[0] = call("POST", "/api/v1/fabric/apps", MANIFEST)["token"]
    call("PUT", f"{base}/subscriptions", {"topics": ["lifecycle", "world"]})

    def show(lifecycle):
        call("PUT", f"{base}/ui", [
            {"id": "open", "slot": "map_control", "label": "Hello", "icon": "gauge", "opens": "panel"},
            {"id": "panel", "slot": "panel", "title": "Hello", "widgets": [{"type": "keyvalues", "items": [{"label": "Simulation", "value": lifecycle}]}]},
        ])

    show("Waiting")
    # Ready: from here the launcher may start the simulation.
    call("PUT", f"{base}/state", {"state": "active"})

    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
    signal.signal(signal.SIGINT, lambda *_: stopping.append(True))
    since = 0
    while not stopping:
        page = call("GET", f"{base}/events?since={since}")
        since = page["sequence"]
        for event in page["items"]:
            if event["type"] == "lifecycle.changed":
                show(event["data"]["to"].title())
        call("POST", f"{base}/heartbeat", {})
        time.sleep(1)
    call("DELETE", base)


if __name__ == "__main__":
    try:
        main()
    except (urllib.error.URLError, OSError) as error:
        raise SystemExit(f"Hello could not reach the simulator: {error}")
