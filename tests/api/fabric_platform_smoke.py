#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""What Fabric gives an application beyond its own surfaces, against a real server and a real run.

Discovery, atomic UI batches, the application's own store across a restart, messages between
applications, subscriptions to the simulation, timers on its clock, and health.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BASE = "/api/v1/fabric/apps"
FIXTURE = "data/fixtures/real_network.osm.xml"


class Server:
    def __init__(self, logs):
        self.logs = logs
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.process = subprocess.Popen(
            [os.environ.get("DSTNS_SERVER", str(ROOT / "build/dstns_server")), "--host", "127.0.0.1", "--port", str(self.port), "--logs", logs],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.monotonic() + 10
        while True:
            try:
                if self.call("GET", "/health")[0] == 200:
                    break
            except OSError:
                if time.monotonic() > end:
                    raise
                time.sleep(0.02)
        self.operator = (Path(logs) / "operator.token").read_text().strip()

    def call(self, method, route, data=None, token=None, headers=None):
        sent = {"Content-Type": "application/json", **(headers or {})}
        if token:
            sent["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{route}", method=method, headers=sent,
                                         data=None if data is None else json.dumps(data).encode())
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def stop(self):
        self.process.terminate()
        self.process.wait(timeout=10)


def code(result):
    return result[1].get("error", {}).get("code")


def manifest(app_id, *capabilities):
    return {"id": app_id, "name": app_id.split(".")[-1].title(), "version": "1.0.0", "capabilities": list(capabilities)}


def status(id_, text="on"):
    return {"id": id_, "slot": "status", "text": text}


def main():
    with tempfile.TemporaryDirectory() as tmp:
        server = Server(tmp)
        call = server.call
        try:
            # Discovery says what there is, without an application or a token.
            found = call("GET", "/api/v1/fabric/capabilities")[1]["data"]
            assert "storage" in found["capabilities"]["automatic"] and "control.playback" in found["capabilities"]["needs_a_person"]
            assert {"table", "gauge", "bars", "keyvalues"} <= set(found["widgets"])
            assert found["limits"]["storage_bytes"] > 0

            status_a, a = call("POST", BASE, manifest("org.test.alpha", "sim.read", "storage", "apps.messages", "ui.status"))
            assert status_a == 201, a
            token_a = a["data"]["token"]
            token_b = call("POST", BASE, manifest("org.test.beta", "sim.read", "storage", "apps.messages"))[1]["data"]["token"]
            token_c = call("POST", BASE, manifest("org.test.gamma", "ui.status"))[1]["data"]["token"]
            alpha, beta, gamma = f"{BASE}/org.test.alpha", f"{BASE}/org.test.beta", f"{BASE}/org.test.gamma"

            # A batch applies whole or not at all.
            assert call("POST", f"{alpha}/ui/batch", {"upsert": [status("one"), status("two")]}, token_a)[0] == 200
            assert call("POST", f"{alpha}/ui/batch", {"upsert": [status("three")], "remove": ["missing"]}, token_a)[0] == 404
            ui = call("GET", "/api/v1/fabric/state")[1]["data"]["apps"]
            ids = [e["id"] for app in ui if app["id"] == "org.test.alpha" for e in app["ui"]]
            assert sorted(ids) == ["one", "two"], ids
            assert call("POST", f"{alpha}/ui/batch", {"upsert": [status("three")], "remove": ["one"]}, token_a)[0] == 200

            # The application's own store: private, bounded, and it survives a restart.
            assert call("PUT", f"{alpha}/storage/prefs", {"theme": "plain", "n": 3}, token_a)[0] == 200
            assert call("GET", f"{alpha}/storage/prefs", token=token_a)[1]["data"]["value"] == {"theme": "plain", "n": 3}
            assert "prefs" in call("GET", f"{alpha}/storage", token=token_a)[1]["data"]["keys"]
            assert call("GET", f"{alpha}/storage/prefs", token=token_b)[0] == 401, "another application cannot read it"
            assert code(call("GET", f"{gamma}/storage", token=token_c)) == "CAPABILITY_NOT_GRANTED"
            assert code(call("GET", f"{alpha}/storage/absent", token=token_a)) == "KEY_NOT_FOUND"
            assert code(call("PUT", f"{alpha}/storage/big", {"x": "y" * 300000}, token_a)) == "STORAGE_FULL"
            assert call("PUT", f"{alpha}/storage/gone", 1, token_a)[0] == 200
            assert call("DELETE", f"{alpha}/storage/gone", token=token_a)[0] == 200

            # Messages arrive as events; only for those who asked to use them.
            assert call("POST", f"{alpha}/messages", {"to": "org.test.beta", "type": "hello", "data": {"n": 1}}, token_a)[0] == 202
            received = call("GET", f"{beta}/events", token=token_b)[1]["data"]["items"]
            message = next(e for e in received if e["type"] == "message")
            assert message["data"] == {"from": "org.test.alpha", "type": "hello", "data": {"n": 1}}, message
            assert code(call("POST", f"{alpha}/messages", {"to": "org.test.gamma", "type": "hello"}, token_a)) == "RECIPIENT_NOT_LISTENING"
            assert code(call("POST", f"{gamma}/messages", {"to": "org.test.beta", "type": "hello"}, token_c)) == "CAPABILITY_NOT_GRANTED"
            assert code(call("POST", f"{alpha}/messages", {"to": "org.test.beta", "type": "x", "data": "z" * 20000}, token_a)) == "MESSAGE_TOO_LARGE"

            # Subscriptions and timers, on a real run.
            assert code(call("PUT", f"{beta}/subscriptions", {"topics": ["nonsense"]}, token_b)) == "INVALID_TOPICS"
            assert code(call("PUT", f"{gamma}/subscriptions", {"topics": ["news"]}, token_c)) == "CAPABILITY_NOT_GRANTED"
            assert call("PUT", f"{beta}/subscriptions", {"topics": ["lifecycle", "world", "news"]}, token_b)[1]["data"]["topics"] == ["lifecycle", "news", "world"]
            assert code(call("PUT", f"{beta}/timers/early", {"at_s": -1}, token_b)) == "INVALID_TIMER"
            assert call("PUT", f"{beta}/timers/early", {"at_s": 60, "data": {"why": "test"}}, token_b)[0] == 200
            assert call("PUT", f"{beta}/timers/every", {"at_s": 120, "every_s": 120}, token_b)[0] == 200
            assert call("PUT", f"{beta}/timers/later", {"at_s": 80000}, token_b)[0] == 200
            assert call("DELETE", f"{beta}/timers/later", token=token_b)[0] == 200
            assert code(call("DELETE", f"{beta}/timers/later", token=token_b)) == "TIMER_NOT_FOUND"
            assert [t["id"] for t in call("GET", f"{beta}/timers", token=token_b)[1]["data"]["items"]] == ["early", "every"]
            operator = {"X-DSTNS-Operator": server.operator}
            # Followed from before the run, so that its first news and its start are seen.
            call("GET", f"{beta}/events", token=token_b)
            started = call("POST", "/api/v1/playback/start", {"seed": "10775", "playback_duration_seconds": 600, "map": {"osm_file": FIXTURE}}, headers=operator)
            assert started[0] == 202, started
            events, since, end = [], 0, time.monotonic() + 40
            while time.monotonic() < end:
                page = call("GET", f"{beta}/events?since={since}", token=token_b)[1]["data"]
                events += page["items"]
                since = page["sequence"]
                kinds = {e["type"] for e in events}
                if {"timer", "news", "lifecycle.changed"} <= kinds and sum(1 for e in events if e["type"] == "timer" and e["data"]["id"] == "every") >= 2:
                    break
                time.sleep(0.2)
            kinds = {e["type"] for e in events}
            assert {"timer", "news", "lifecycle.changed"} <= kinds, kinds
            early = [e for e in events if e["type"] == "timer" and e["data"]["id"] == "early"]
            assert len(early) == 1 and early[0]["data"]["data"] == {"why": "test"}, early
            every = [e["data"]["at_s"] for e in events if e["type"] == "timer" and e["data"]["id"] == "every"]
            assert every[:2] == [120, 240], every
            assert all(e["data"]["virtual_s"] >= e["data"]["at_s"] for e in events if e["type"] == "timer")
            # Only what was asked for.
            token_d = call("POST", BASE, manifest("org.test.delta", "sim.read"))[1]["data"]["token"]
            delta = f"{BASE}/org.test.delta"
            assert call("PUT", f"{delta}/subscriptions", {"topics": ["news.incident"]}, token_d)[0] == 200
            time.sleep(0.5)
            only = call("GET", f"{delta}/events", token=token_d)[1]["data"]["items"]
            assert all(e["type"] != "news" or e["data"]["category"] == "incident" for e in only), only

            # Health, for the application itself or for a supervisor.
            health = call("GET", f"{beta}/health", token=token_b)[1]["data"]
            assert health["requests"] > 3 and health["timers"] == 2 and health["messages"]["received"] == 1 and health["storage"]["keys"] == 0, health
            assert call("GET", f"{alpha}/health", headers=operator)[1]["data"]["messages"]["sent"] == 1
            assert call("GET", f"{alpha}/health")[0] == 401
            server.stop()
            server = Server(tmp)
            call = server.call
            # It returns as itself, with its token, and finds what it left.
            assert call("POST", BASE, manifest("org.test.alpha", "sim.read", "storage", "apps.messages", "ui.status"), token_a)[0] in {200, 201}
            assert call("GET", f"{alpha}/storage/prefs", token=token_a)[1]["data"]["value"]["n"] == 3, "the store survives a restart"
        finally:
            server.stop()
    print("fabric platform ok")


if __name__ == "__main__":
    main()
