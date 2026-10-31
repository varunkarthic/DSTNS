#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Applications registering themselves with Fabric, against a real server.

Several applications at once: identity and conflicts, capability enforcement,
settings isolation, validation, migration, persistence across a restart, failure
isolation, lease expiry and lossless event delivery.
"""
import concurrent.futures as futures
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
HOST = {"X-DSTNS-Host": "observer"}


def manifest(app_id, **extra):
    return {"id": app_id, "name": app_id.split(".")[-1].title(), "version": "1.0.0", "capabilities": ["ui.status", "ui.notifications", "settings", "sim.read"],
            "settings": {"version": 1, "groups": [{"id": "general", "label": "General", "fields": [
                {"id": "enabled", "label": "Enabled", "type": "toggle", "default": True},
                {"id": "level", "label": "Level", "type": "slider", "min": 0, "max": 10, "default": 5},
                {"id": "mode", "label": "Mode", "type": "select", "default": "a", "options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}]},
                {"id": "name", "label": "Name", "type": "text", "default": "x", "max_length": 8}]}]}, **extra}


class Server:
    def __init__(self, logs):
        self.logs = logs
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.process = subprocess.Popen(
            [os.environ.get("DSTNS_SERVER", str(ROOT / "build/dstns_server")), "--host", "127.0.0.1", "--port", str(self.port), "--logs", logs, "--map-cache", "keep"],
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


def main():
    with tempfile.TemporaryDirectory(prefix="dstns-fabric-") as tmp:
        server = Server(tmp)
        call = server.call
        try:
            # Several applications, registered concurrently, each with its own token.
            ids = [f"org.example.app{i}" for i in range(12)]
            with futures.ThreadPoolExecutor(12) as pool:
                results = list(pool.map(lambda i: call("POST", BASE, manifest(i)), ids))
            assert all(r[0] == 201 for r in results), results
            tokens = {i: r[1]["data"]["token"] for i, r in zip(ids, results)}
            assert len(set(tokens.values())) == 12
            listed = call("GET", BASE)[1]["data"]["items"]
            assert {a["id"] for a in listed} == set(ids) and all("token" not in a for a in listed)
            a, b = ids[0], ids[1]
            ta, tb = tokens[a], tokens[b]

            # Identity: a live ID cannot be taken, reserved names cannot be used.
            assert code(call("POST", BASE, manifest(a))) == "APP_ID_CONFLICT"
            assert call("POST", BASE, manifest(a, version="1.1.0"), ta)[0] == 201, "the owner may update"
            for bad, expected in [({"id": "dstns.thing", "name": "x", "version": "1"}, "APP_ID_RESERVED"), ({"id": "org.x.y", "name": "WebFabric", "version": "1"}, "APP_NAME_RESERVED"),
                                  ({"id": "../x", "name": "x", "version": "1"}, "INVALID_MANIFEST"), ({"id": "org.x.y", "name": "x", "version": "1", "capabilities": ["root"]}, "INVALID_MANIFEST"),
                                  ({"id": "org.x.y", "name": "x", "version": "1", "requires_api": 2}, "APP_INCOMPATIBLE"),
                                  ({"id": "org.x.y", "name": "x", "version": "1", "settings": {"groups": [{"id": "g", "label": "G", "fields": [{"id": "f", "label": "F", "type": "toggle", "default": "yes"}]}]}}, "INVALID_MANIFEST")]:
                assert code(call("POST", BASE, bad)) == expected, bad

            # Authentication: another application's token is worthless.
            assert code(call("POST", f"{BASE}/{a}/heartbeat", {}, tb)) == "APP_TOKEN_INVALID"
            assert code(call("POST", f"{BASE}/{a}/heartbeat", {})) == "APP_TOKEN_INVALID"
            assert call("POST", f"{BASE}/{a}/heartbeat", {}, ta)[0] == 200
            assert call("GET", f"{BASE}/{a}")[1]["data"]["state"] == "active"

            # Settings: validated, atomic, namespaced.
            assert call("PUT", f"{BASE}/{a}/settings", {"level": 7}, ta)[1]["data"]["values"]["level"] == 7
            assert call("GET", f"{BASE}/{b}/settings", token=tb)[1]["data"]["values"]["level"] == 5, "b is untouched"
            assert code(call("GET", f"{BASE}/{a}/settings", token=tb)) == "APP_TOKEN_INVALID", "b cannot read a"
            assert code(call("PUT", f"{BASE}/{a}/settings", {"level": 1}, tb)) == "APP_TOKEN_INVALID", "b cannot write a"
            assert code(call("GET", f"{BASE}/{a}/settings")) == "APP_TOKEN_INVALID"
            for bad_change in ({"level": 11}, {"level": "high"}, {"mode": "c"}, {"name": "far too long"}, {"enabled": 1}, {"unknown": 1}):
                assert code(call("PUT", f"{BASE}/{a}/settings", bad_change, ta)) == "INVALID_SETTINGS", bad_change
            assert code(call("PUT", f"{BASE}/{a}/settings", {"mode": "b", "level": 99}, ta)) == "INVALID_SETTINGS"
            assert call("GET", f"{BASE}/{a}/settings", headers=HOST)[1]["data"]["values"]["mode"] == "a", "nothing applied from a refused change"
            assert call("PUT", f"{BASE}/{a}/settings", {"mode": "b"}, headers=HOST)[0] == 200
            events = call("GET", f"{BASE}/{a}/events", token=ta)[1]["data"]["items"]
            assert any(e["type"] == "settings.changed" and e["data"]["changes"] == {"mode": "b"} for e in events), "changes reach the app without a restart"
            assert call("DELETE", f"{BASE}/{a}/settings", headers=HOST)[1]["data"]["values"]["mode"] == "a"
            assert call("PUT", f"{BASE}/{a}/settings", {"level": 8}, ta)[0] == 200

            # Capabilities: requested in the manifest, then granted.
            assert code(call("PUT", f"{BASE}/{a}/ui/x", {"slot": "dialog", "title": "t"}, ta)) == "CAPABILITY_NOT_REQUESTED"
            assert code(call("POST", f"{BASE}/{a}/control", {"action": "pause"}, ta)) == "CAPABILITY_NOT_GRANTED"
            controller = "org.example.controller"
            r = call("POST", BASE, manifest(controller, capabilities=["ui.status", "control.playback", "control.events", "ui.dialogs", "ui.frames", "ui.panels"]))
            tc = r[1]["data"]["token"]
            assert code(call("POST", f"{BASE}/{controller}/control", {"action": "pause"}, tc)) == "CAPABILITY_NOT_GRANTED", "control is never automatic"
            assert code(call("PUT", f"{BASE}/{controller}/grants", {"capabilities": ["control.playback"]}, tc)) == "HOST_REQUIRED", "an app cannot grant itself"
            evil = {"Origin": "null", "X-DSTNS-Host": "observer"}
            assert call("PUT", f"{BASE}/{controller}/grants", {"capabilities": ["control.playback"]}, headers=evil)[0] == 403, "a sandboxed frame cannot grant"
            assert call("GET", f"{BASE}/{controller}/settings", headers=evil)[0] == 401, "a sandboxed frame cannot read settings"
            assert code(call("PUT", f"{BASE}/{controller}/grants", {"capabilities": ["root"]}, headers={"X-DSTNS-Operator": server.operator})) == "CAPABILITY_NOT_REQUESTED"

            # Control: granted, audited, and only what the capability covers.
            token_start = call("POST", "/api/v1/playback/start", {"seed": "12345", "playback_duration_seconds": 3600, "map": {"osm_file": "tests/fixtures/roads.osm.xml"}}, headers={"X-DSTNS-Operator": server.operator})
            assert token_start[0] == 202, token_start
            end = time.monotonic() + 15
            while call("GET", "/api/v1/playback/status")[1]["data"]["lifecycle"] != "RUNNING":
                assert time.monotonic() < end
                time.sleep(0.05)
            assert call("PUT", f"{BASE}/{controller}/grants", {"capabilities": ["ui.status", "control.playback"]}, headers=HOST)[0] == 200
            assert call("POST", f"{BASE}/{controller}/control", {"action": "pause"}, tc)[0] == 200
            assert call("GET", "/api/v1/playback/status")[1]["data"]["lifecycle"] == "PAUSED"
            assert code(call("POST", f"{BASE}/{controller}/control", {"action": "surge", "params": {"node_id": 0}}, tc)) == "CAPABILITY_NOT_GRANTED"
            assert code(call("POST", f"{BASE}/{controller}/control", {"action": "terminate"}, tc)) == "UNKNOWN_ACTION", "shutdown is never offered"
            assert call("POST", f"{BASE}/{controller}/control", {"action": "seek", "params": {"target_time": 90000}}, tc)[0] == 400
            audit = call("GET", "/api/v1/fabric/audit")[1]["data"]["items"]
            assert [e["action"] for e in audit] == ["pause", "seek"] and audit[0]["app_id"] == controller and audit[0]["run_id"]
            assert audit[1]["outcome"].startswith("refused")

            # Declared UI: slots, tones and frames are checked; a frame needs its grant.
            assert code(call("PUT", f"{BASE}/{a}/ui", [{"id": "s", "slot": "status", "tone": "#ff0000"}], ta)) == "INVALID_ELEMENT", "no colours"
            assert code(call("PUT", f"{BASE}/{a}/ui", [{"id": "s", "slot": "nowhere"}], ta)) == "INVALID_ELEMENT"
            assert code(call("PUT", f"{BASE}/{a}/ui", [{"id": "s", "slot": "status"}, {"id": "s", "slot": "status"}], ta)) == "INVALID_ELEMENT"
            assert call("PUT", f"{BASE}/{a}/ui", [{"id": "s", "slot": "status", "label": "Load", "value": "1", "tone": "ok"}], ta)[0] == 200
            before = call("GET", "/api/v1/fabric/state")[1]["data"]
            assert not before["unchanged"]
            assert call("GET", f"/api/v1/fabric/state?since={before['revision']}")[1]["data"]["unchanged"], "an idle poll costs nothing"
            assert code(call("PUT", f"{BASE}/{controller}/ui/f", {"slot": "panel", "frame": "javascript:alert(1)"}, tc)) == "INVALID_ELEMENT"
            assert call("PUT", f"{BASE}/{controller}/ui/f", {"slot": "panel", "title": "F", "frame": "https://app.example/"}, tc)[0] == 200
            view = call("GET", f"{BASE}/{controller}")[1]["data"]
            assert view["blocked_ui"] == ["f"] and view["ui"] == [], "an ungranted frame is not offered to the page"

            # High-frequency updates coalesce into the latest state, concurrently.
            def update(n):
                return call("PUT", f"{BASE}/{b}/ui/s", {"slot": "status", "label": "Tick", "value": str(n)}, tb)[0]
            with futures.ThreadPoolExecutor(8) as pool:
                assert set(pool.map(update, range(200))) == {200}
            state = call("GET", "/api/v1/fabric/state")[1]["data"]
            target = next(x for x in state["apps"] if x["id"] == b)
            assert len(target["ui"]) == 1, "200 updates are one element"

            # Notifications are never lost silently: delivered in order or refused.
            sent, refused = [], 0
            for n in range(120):
                r = call("POST", f"{BASE}/{b}/notifications", {"title": f"n{n}", "severity": "info"}, tb)
                if r[0] == 202:
                    sent.append(n)
                else:
                    assert code(r) == "RATE_LIMITED"
                    refused += 1
            assert refused > 0, "a flood meets the rate limit"
            seen, cursor = [], 0
            while True:
                page = call("GET", f"/api/v1/fabric/state?since=0&notifications_since={cursor}")[1]["data"]
                if not page["notifications"]:
                    break
                seen += page["notifications"]
                cursor = page["notifications"][-1]["sequence"]
            assert [m["title"] for m in seen if m["app_id"] == b] == [f"n{n}" for n in sent]
            assert code(call("POST", f"{BASE}/{a}/notifications", {"title": ""}, ta)) == "INVALID_NOTIFICATION"

            # A viewer's action reaches only its own application, in order.
            for n in range(5):
                assert call("POST", f"{BASE}/{a}/actions", {"element": "s", "value": n}, headers=HOST)[0] == 202
            assert call("POST", f"{BASE}/{a}/actions", {"element": "s"}, ta)[0] == 403
            actions = [e["data"]["value"] for e in call("GET", f"{BASE}/{a}/events", token=ta)[1]["data"]["items"] if e["type"] == "ui.action"]
            assert actions == list(range(5))
            assert not [e for e in call("GET", f"{BASE}/{b}/events", token=tb)[1]["data"]["items"] if e["type"] == "ui.action"]

            # One application failing or being suspended leaves the others alone.
            assert call("POST", f"{BASE}/{b}/failure", {"detail": "frame crashed"}, headers=HOST)[0] == 200
            state = {x["id"]: x for x in call("GET", "/api/v1/fabric/state")[1]["data"]["apps"]}
            assert state[b]["state"] == "failed" and state[b]["ui"] == [] and state[a]["ui"]
            assert code(call("POST", f"{BASE}/{b}/notifications", {"title": "x"}, tb)) == "APP_NOT_ACTIVE"
            assert call("PUT", f"{BASE}/{b}/state", {"state": "active"}, tb)[0] == 200, "an application can recover"
            assert call("POST", f"{BASE}/{a}/suspend", {}, headers=HOST)[0] == 200
            assert call("GET", f"{BASE}/{a}")[1]["data"]["ui"] == []
            assert code(call("PUT", f"{BASE}/{a}/state", {"state": "active"}, ta)) == "APP_SUSPENDED", "only the person resumes it"
            assert call("POST", f"{BASE}/{a}/resume", {}, headers=HOST)[0] == 200
            assert call("GET", f"{BASE}/{a}")[1]["data"]["ui"]

            # Leases: silence suspends, a call recovers, longer silence unloads.
            short = "org.example.short"
            ts = call("POST", BASE, manifest(short, lease_s=1))[1]["data"]["token"]
            assert call("PUT", f"{BASE}/{short}/ui/s", {"slot": "status", "label": "L"}, ts)[0] == 200
            assert call("POST", f"{BASE}/{short}/heartbeat", {}, ts)[0] == 200
            time.sleep(1.3)
            view = call("GET", f"{BASE}/{short}")[1]["data"]
            assert view["state"] == "suspended" and view["ui"] == []
            assert call("POST", f"{BASE}/{short}/heartbeat", {}, ts)[0] == 200
            assert call("GET", f"{BASE}/{short}")[1]["data"]["state"] == "active"
            time.sleep(5.3)
            assert call("GET", f"{BASE}/{short}")[1]["data"]["state"] == "unloaded"
            assert code(call("POST", f"{BASE}/{short}/heartbeat", {}, ts)) == "APP_NOT_ACTIVE"
            assert call("POST", BASE, manifest(short))[0] == 201, "an unprivileged ID that left can return"

            # Unregistering keeps identity; forgetting is a person's act.
            assert call("DELETE", f"{BASE}/{ids[2]}", token=tokens[ids[2]])[0] == 200
            assert call("GET", f"{BASE}/{ids[2]}")[1]["data"]["state"] == "unloaded"
            assert code(call("DELETE", f"{BASE}/{ids[3]}", token=tb)) == "APP_TOKEN_INVALID"
            assert call("DELETE", f"{BASE}/{ids[4]}", headers=HOST)[0] == 200
            assert call("GET", f"{BASE}/{ids[4]}")[0] == 404
        finally:
            server.stop()

        # A restart: identity, grants and settings persist; run-time UI does not.
        server = Server(tmp)
        call = server.call
        try:
            view = call("GET", f"{BASE}/{a}")[1]["data"]
            assert view["state"] == "unloaded", view
            assert code(call("POST", BASE, manifest(controller, capabilities=["control.playback"]))) == "APP_ID_CONFLICT", "granted IDs need their token"
            back = call("POST", BASE, manifest(controller, capabilities=["ui.status", "control.playback"]), tc)
            assert back[0] == 201 and "control.playback" in back[1]["data"]["app"]["capabilities"]["granted"]
            r = call("POST", BASE, manifest(a), ta)
            assert r[1]["data"]["token"] == ta
            assert call("GET", f"{BASE}/{a}/settings", token=ta)[1]["data"]["values"]["level"] == 8

            # Schema migration: renames applied, invalid values reset, the app told.
            migrated = manifest(a)
            migrated["settings"]["version"] = 2
            migrated["settings"]["migrations"] = {"1": {"rename": {"level": "intensity"}}}
            fields = migrated["settings"]["groups"][0]["fields"]
            fields[1]["id"] = "intensity"
            fields[1]["max"] = 9
            fields.append({"id": "extra", "label": "Extra", "type": "number", "default": 2})
            assert call("POST", BASE, migrated, ta)[0] == 201
            values = call("GET", f"{BASE}/{a}/settings", token=ta)[1]["data"]
            assert values["version"] == 2 and values["values"]["intensity"] == 8 and values["values"]["extra"] == 2 and "level" not in values["values"]
            assert any(e["type"] == "settings.migrated" for e in call("GET", f"{BASE}/{a}/events", token=ta)[1]["data"]["items"])

            # Credentials stay private on disk, and the existing API is untouched.
            mode = os.stat(Path(tmp) / "fabric-apps.json").st_mode & 0o777
            assert mode == 0o600, oct(mode)
            assert call("GET", "/health")[0] == 200
            groups = call("GET", "/api/v1/system/endpoints")[1]["groups"]
            assert any(g["group"] == "fabric" for g in groups)
            assert call("GET", "/api/v1/system/source")[1]["api_version"] == "1.1"
        finally:
            server.stop()
    print("fabric apps ok")


if __name__ == "__main__":
    main()
