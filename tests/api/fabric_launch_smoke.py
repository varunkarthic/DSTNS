#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""What the operator can turn on and off, web applications, components on a grid, and reloading an application.

Each switch is tried on a server of its own, since they are read once at start.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BASE = "/api/v1/fabric/apps"


class Server:
    def __init__(self, logs, **environment):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        env = {key: value for key, value in os.environ.items() if not key.startswith("DSTNS_") or key == "DSTNS_SERVER"}
        env.update(environment)
        self.process = subprocess.Popen([os.environ.get("DSTNS_SERVER", str(ROOT / "build/dstns_server")), "--host", "127.0.0.1", "--port", str(self.port), "--logs", logs],
                                        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.monotonic() + 10
        while True:
            try:
                if self.call("GET", "/health")[0] == 200:
                    break
            except OSError:
                if time.monotonic() > end:
                    raise
                time.sleep(0.02)
        self.host = {"X-DSTNS-Operator": (Path(logs) / "operator.token").read_text().strip()}

    def call(self, method, route, data=None, token=None, headers=None):
        sent = {"Content-Type": "application/json", **(headers or {})}
        if token:
            sent["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{route}", method=method, headers=sent, data=None if data is None else json.dumps(data).encode())
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


def server(**environment):
    return Server(tempfile.mkdtemp(), **environment)


def main():
    # Out of the box.
    s = server()
    try:
        features = s.call("GET", "/api/v1/system/features")[1]["data"]
        assert features["applications"] and features["legacy_api"] and features["launch_proposals"] and not features["require_signatures"]
        assert features["presentation"] == {"webfabric": True, "force_animate": True, "fast_boot": False, "demo": False, "music": False, "fullscreen": False, "music_volume": 0.6,
                                        "map_fps": 0, "render_scale": 2.0, "film_particles": 32000}, features
        assert features["performance"] == {"compression": "fast", "api_threads": "auto", "engine_threads": "auto"}, features
        assert s.call("GET", "/api/v1/playback/status")[0] == 200

        # A web interface of its own, opened in a tab, and only over http or https.
        app = {"id": "org.test.web", "name": "Web", "version": "1.0.0", "capabilities": ["ui.panels", "ui.camera"], "web": {"url": "http://127.0.0.1:5173/", "label": "Open planner"}}
        made = s.call("POST", BASE, app)
        assert made[0] == 201 and made[1]["data"]["app"]["web"] == app["web"], made
        for wrong in ({"url": "javascript:alert(1)"}, {"url": "file:///etc/passwd"}, {"label": "x"}, "http://x", {"url": "http://x", "label": "x" * 41}):
            refused = s.call("POST", BASE, {**app, "id": "org.test.webx", "web": wrong})
            assert refused[0] == 400 and code(refused) == "INVALID_MANIFEST", (wrong, refused)
        token = made[1]["data"]["token"]

        # Components on a grid.
        good = {"id": "board", "slot": "panel", "title": "Board", "layout": {"columns": 6}, "widgets": [
            {"type": "metric", "label": "Buses", "value": "12", "area": {"column": 1, "row": 1, "width": 3, "height": 1}},
            {"type": "link", "label": "Open", "url": "https://example.org/", "area": {"column": 4, "width": 3}},
            {"type": "tabs", "tabs": [{"id": "a", "label": "A", "widgets": [{"type": "chart", "series": [{"label": "x", "points": [1, 2, 3]}]}]}]}]}
        assert s.call("PUT", f"{BASE}/org.test.web/ui/board", good, token=token)[0] == 200
        for wrong in ({"layout": {"columns": 13}}, {"widgets": [{"type": "link", "url": "javascript:x"}]}, {"widgets": [{"type": "text", "area": {"column": 0}}]},
                      {"widgets": [{"type": "text", "area": {"width": 13}}]}, {"widgets": [{"text": "no type"}]},
                      {"widgets": [{"type": "card", "widgets": [{"type": "card", "widgets": [{"type": "card", "widgets": [{"type": "card", "widgets": [{"type": "card", "widgets": []}]}]}]}]}]}):
            refused = s.call("PUT", f"{BASE}/org.test.web/ui/board", {**good, **wrong}, token=token)
            assert refused[0] == 400 and code(refused) == "INVALID_ELEMENT", (wrong, refused)

        # Reloading something the launcher did not start: its link ends, and it starts again as new.
        assert s.call("PUT", f"{BASE}/org.test.web/grants", {"capabilities": ["ui.panels", "ui.camera"]}, headers=s.host)[0] == 200
        assert s.call("POST", f"{BASE}/org.test.web/reload", {}, token=token)[0] == 403, "only a person reloads"
        reloaded = s.call("POST", f"{BASE}/org.test.web/reload", {}, headers=s.host)
        assert reloaded[0] == 200 and reloaded[1]["data"]["managed"] is False, reloaded
        assert s.call("POST", f"{BASE}/org.test.web/heartbeat", {}, token=token)[0] == 401, "the old link is gone"
        state = s.call("GET", "/api/v1/fabric/state")[1]["data"]
        assert state["reloads"][-1]["app"] == "org.test.web" and state["reload_sequence"] >= 1
        again = s.call("POST", BASE, app)
        assert again[0] == 201 and again[1]["data"]["token"] != token
        assert "ui.camera" not in again[1]["data"]["app"]["capabilities"]["granted"], "nobody could prove to be it, so a person grants again"

        # Reloading something the launcher started: it comes back with the launcher's key, and keeps its grants and storage.
        managed = {"id": "org.test.managed", "name": "Managed", "version": "1.0.0", "capabilities": ["ui.camera", "storage"]}
        token_m = s.call("POST", BASE, managed)[1]["data"]["token"]
        assert s.call("PUT", f"{BASE}/org.test.managed/grants", {"capabilities": ["ui.camera", "storage"]}, headers=s.host)[0] == 200
        assert s.call("PUT", f"{BASE}/org.test.managed/storage/k", {"value": 7}, token=token_m)[0] == 200
        assert s.call("PUT", "/api/v1/fabric/launch/plan", {"apps": [{"id": "org.test.managed", "name": "Managed", "state": "ready"}]}, headers=s.host)[0] == 200
        assert s.call("PUT", "/api/v1/fabric/launch/org.test.managed/key", {"key_sha256": "x"}, headers=s.host)[0] == 400
        assert s.call("PUT", "/api/v1/fabric/launch/org.test.managed/key", {"key_sha256": "0" * 64}, token=token_m)[0] == 403, "only the launcher"
        assert s.call("POST", f"{BASE}/org.test.managed/reload", {}, headers=s.host)[1]["data"]["managed"] is True
        assert s.call("GET", f"{BASE}/org.test.managed")[1]["data"]["state"] == "reloading"
        key = secrets.token_hex(32)
        assert s.call("PUT", "/api/v1/fabric/launch/org.test.managed/key", {"key_sha256": hashlib.sha256(key.encode()).hexdigest()}, headers=s.host)[0] == 200
        wrong_key = s.call("POST", BASE, managed, headers={"X-DSTNS-Launch-Key": secrets.token_hex(32)})
        assert wrong_key[0] == 409 and code(wrong_key) == "APP_ID_CONFLICT", wrong_key
        back = s.call("POST", BASE, managed, headers={"X-DSTNS-Launch-Key": key})
        assert back[0] == 201, back
        assert set(back[1]["data"]["app"]["capabilities"]["granted"]) == {"ui.camera", "storage"}, "it kept what a person gave it"
        token_b = back[1]["data"]["token"]
        assert s.call("GET", f"{BASE}/org.test.managed/storage/k", token=token_b)[1]["data"]["value"] in (7, {"value": 7}), "storage kept"
        assert s.call("POST", f"{BASE}/org.test.managed/heartbeat", {}, token=token_m)[0] == 401
        used = s.call("POST", BASE, managed, headers={"X-DSTNS-Launch-Key": key})
        assert used[0] == 409, "a launch key works once"
    finally:
        s.stop()

    # The operator's switches.
    s = server(DSTNS_LEGACY_API="0", DSTNS_FABRIC_APPS="0", DSTNS_LAUNCH_PROPOSALS="0", DSTNS_DISABLED_CAPABILITIES="control.world, ui.frames, nonsense",
               DSTNS_PRESENTATION=json.dumps({"fast_boot": True, "music": True, "fullscreen": "yes", "music_volume": 3, "junk": 1}))
    try:
        features = s.call("GET", "/api/v1/system/features")[1]["data"]
        assert not features["legacy_api"] and not features["applications"] and not features["launch_proposals"]
        assert sorted(features["disabled_capabilities"]) == ["control.world", "ui.frames"], features
        p = features["presentation"]
        assert p["fast_boot"] and p["music"] and not p["force_animate"] and not p["fullscreen"] and p["music_volume"] == 1 and "junk" not in p, p
        gone = s.call("GET", "/api/v1/playback/status")
        assert gone[0] == 410 and code(gone) == "LEGACY_API_DISABLED", gone
        assert s.call("POST", "/api/v1/control/day", {"day": 1})[0] == 410
        assert s.call("GET", "/api/v1/fabric/engine/status")[0] == 200, "the Fabric API answers"
        refused = s.call("POST", BASE, {"id": "org.test.x", "name": "X", "version": "1.0.0"})
        assert refused[0] == 403 and code(refused) == "APPLICATIONS_DISABLED", refused
        assert s.call("GET", BASE)[0] == 200
        assert s.call("GET", "/api/v1/fabric/capabilities")[1]["data"]["switches"]["disabled_capabilities"] == ["control.world", "ui.frames"]
    finally:
        s.stop()

    s = server(DSTNS_REQUIRE_SIGNATURES="1", DSTNS_DISABLED_CAPABILITIES="control.world", DSTNS_LAUNCH_PROPOSALS="0", DSTNS_PRESENTATION="not json")
    try:
        assert s.call("GET", "/api/v1/system/features")[1]["data"]["presentation"]["fast_boot"] is False, "a malformed setting leaves the defaults"
        made = s.call("POST", BASE, {"id": "org.test.s", "name": "S", "version": "1.0.0", "capabilities": ["control.world", "control.playback"]})[1]["data"]
        assert made["app"]["security"]["signatures_required"] is True
        unsigned = s.call("POST", f"{BASE}/org.test.s/heartbeat", {}, token=made["token"])
        assert unsigned[0] == 401 and code(unsigned) == "SIGNATURE_REQUIRED", unsigned
        refused = s.call("PUT", f"{BASE}/org.test.s/grants", {"capabilities": ["control.world"]}, headers=s.host)
        assert refused[0] == 403 and code(refused) == "CAPABILITY_DISABLED", refused
        assert s.call("PUT", f"{BASE}/org.test.s/grants", {"capabilities": ["control.playback"]}, headers=s.host)[0] == 200
        proposal = s.call("PUT", f"{BASE}/org.test.s/launch", {"commands": ["x"]}, token=made["token"])
        assert proposal[0] in (401, 403), proposal
        assert s.call("PUT", "/api/v1/fabric/launch/org.test.s", {"commands": ["x"]}, headers=s.host)[0] == 200, "the operator still can"
    finally:
        s.stop()
    print("fabric launch ok")


if __name__ == "__main__":
    main()
