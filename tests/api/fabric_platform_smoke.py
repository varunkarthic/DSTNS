#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""What Fabric gives an application beyond its own surfaces, against a real server and a real run.

Discovery, atomic UI batches, the application's own store across a restart, messages between
applications, subscriptions to the simulation, timers on its clock, and health.
"""
import hashlib
import hmac
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


def call_raw(server, method, route, data=None, headers=None):
    """As Server.call, with the response's headers too."""
    sent = {"Content-Type": "application/json", **(headers or {})}
    request = urllib.request.Request(f"http://127.0.0.1:{server.port}{route}", method=method, headers=sent, data=None if data is None else json.dumps(data).encode())
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error), dict(error.headers)


def signed(key, method, target, payload=b"", timestamp=None, nonce=None):
    timestamp = str(int(time.time()) if timestamp is None else timestamp)
    nonce = nonce or secrets.token_hex(12)
    message = "\n".join([method, target, timestamp, nonce, hashlib.sha256(payload).hexdigest()])
    return {"X-DSTNS-Timestamp": timestamp, "X-DSTNS-Nonce": nonce, "X-DSTNS-Signature": hmac.new(key.encode(), message.encode(), hashlib.sha256).hexdigest()}


def security_checks(server, token_a, token_b, operator):
    call = server.call
    host = {"X-DSTNS-Host": "observer"}
    # Tokens are not on disk, only their hashes, and the store is sealed.
    store = json.loads((Path(server.logs) / "fabric-apps.json").read_text())
    assert token_a not in json.dumps(store) and "integrity" in store and store["apps"]["org.test.alpha"]["token_hash"]
    assert oct((Path(server.logs) / "fabric-apps.json.key").stat().st_mode & 0o777) == "0o600"

    # An application that asks for signing cannot be driven by its token alone.
    status_, reply = call("POST", BASE, {**manifest("org.test.signed", "storage", "sim.read"), "security": {"require_signatures": True}})
    assert status_ == 201, reply
    token, key = reply["data"]["token"], reply["data"]["signing_key"]
    route = f"{BASE}/org.test.signed/storage/k"
    assert code(call("GET", route, token=token)) == "SIGNATURE_REQUIRED"
    payload = json.dumps({"v": 1}).encode()
    headers = signed(key, "PUT", route, payload)
    request = urllib.request.Request(f"http://127.0.0.1:{server.port}{route}", method="PUT", data=payload, headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}", **headers})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200
        # The response is signed in return, and its digest is of what was sent.
        sent = response.read()
        digest = response.headers["X-DSTNS-Content-SHA256"]
        assert digest == hashlib.sha256(sent).hexdigest()
        expected = hmac.new(key.encode(), f"200\n{headers['X-DSTNS-Nonce']}\n{digest}".encode(), hashlib.sha256).hexdigest()
        assert response.headers["X-DSTNS-Response-Signature"] == expected
    # The same request again is a replay; a changed one, an old one or a guessed one is refused too.
    assert code(call("GET", route, token=token, headers=signed(key, "GET", route))) != "SIGNATURE_INVALID"
    replay = signed(key, "GET", route)
    assert call("GET", route, token=token, headers=replay)[0] == 200
    assert code(call("GET", route, token=token, headers=replay)) == "SIGNATURE_REPLAYED"
    assert code(call("GET", route, token=token, headers=signed(key, "GET", route + "x"))) in {"SIGNATURE_INVALID", "KEY_NOT_FOUND"}
    assert code(call("GET", route, token=token, headers=signed("wrong", "GET", route))) == "SIGNATURE_INVALID"
    assert code(call("GET", route, token=token, headers=signed(key, "GET", route, timestamp=int(time.time()) - 600))) == "SIGNATURE_EXPIRED"

    # Rotating replaces both at once.
    rotate = f"{BASE}/org.test.signed/credentials/rotate"
    fresh = call("POST", rotate, {}, token=token, headers=signed(key, "POST", rotate, b"{}"))[1]["data"]
    assert fresh["token"] != token and fresh["signing_key"] != key
    assert code(call("GET", route, token=token, headers=signed(key, "GET", route))) == "APP_TOKEN_INVALID"
    assert call("GET", route, token=fresh["token"], headers=signed(fresh["signing_key"], "GET", route))[0] == 200

    # A frame comes only from where the manifest says, and asking for more asks a person again.
    app = "org.test.framed"
    frames = {**manifest(app, "ui.frames", "ui.panels"), "frame_origins": ["https://a.example"]}
    token_f = call("POST", BASE, frames)[1]["data"]["token"]
    base_f = f"{BASE}/{app}"
    assert call("PUT", f"{base_f}/ui/p", {"slot": "panel", "frame": "https://a.example/x"}, token_f)[0] == 200
    assert code(call("PUT", f"{base_f}/ui/q", {"slot": "panel", "frame": "https://evil.example/x"}, token_f)) == "FRAME_ORIGIN_NOT_DECLARED"
    assert code(call("PUT", f"{base_f}/ui/r", {"slot": "panel", "frame": "https://a.example.evil.example/x"}, token_f)) == "FRAME_ORIGIN_NOT_DECLARED"
    assert call("PUT", f"{base_f}/grants", {"capabilities": ["ui.frames", "ui.panels"]}, headers=host)[0] == 200
    same = call("POST", BASE, frames, token_f)[1]["data"]["app"]["capabilities"]["granted"]
    assert "ui.frames" in same, "the same origins keep the permission"
    wider = call("POST", BASE, {**frames, "frame_origins": ["https://a.example", "https://b.example"]}, token_f)[1]["data"]["app"]["capabilities"]
    assert "ui.frames" not in wider["granted"] and "ui.frames" in wider["pending"], wider

    # The audit log is a chain, which can be checked.
    token_c = call("POST", BASE, manifest("org.test.auditor", "control.playback"))[1]["data"]["token"]
    assert call("PUT", f"{BASE}/org.test.auditor/grants", {"capabilities": ["control.playback"]}, headers=host)[0] == 200
    for action in ("pause", "play"):
        assert call("POST", f"{BASE}/org.test.auditor/control", {"action": action}, token_c)[0] == 200
    entries = call("GET", "/api/v1/fabric/audit")[1]["data"]["items"]
    assert entries[-1]["previous"] == entries[-2]["hash"], entries[-2:]
    assert call("GET", "/api/v1/fabric/audit/verify", headers=host)[1]["data"]["intact"] is True
    assert call("GET", "/api/v1/fabric/audit/verify")[0] == 403
    posture = call("GET", "/api/v1/fabric/security", headers=operator)[1]["data"]
    assert posture["store"]["tokens"] == "hashed" and posture["audit"]["verification"]["intact"] is True and posture["transport"]["tls"] is False, posture
    assert call("GET", "/api/v1/fabric/security")[0] == 403

    # A launch is only ever proposed. The application, for itself, or the operator, for any.
    assert code(call("PUT", f"{BASE}/org.test.alpha/launch", {"commands": []}, token_a)) == "INVALID_LAUNCH"
    assert call("PUT", f"{BASE}/org.test.alpha/launch", {"commands": ["python3 app.py"]}, token_a)[1]["data"]["proposed_by"] == "application"
    assert call("PUT", "/api/v1/fabric/launch/org.test.other", {"commands": ["x"]})[0] == 403, "not without being the operator"
    assert call("PUT", "/api/v1/fabric/launch/org.test.other", {"commands": ["x"]}, headers=operator)[1]["data"]["proposed_by"] == "operator"
    listed = {p["id"] for p in call("GET", "/api/v1/fabric/launch", headers=operator)[1]["data"]["items"]}
    assert listed == {"org.test.alpha", "org.test.other"}, listed
    assert call("GET", "/api/v1/fabric/launch")[0] == 403
    assert call("DELETE", "/api/v1/fabric/launch/org.test.other", headers=operator)[0] == 200
    # And the observer can be told what is being started.
    assert call("PUT", "/api/v1/fabric/launch/plan", {"apps": [{"id": "x", "name": "X", "state": "starting"}]})[0] == 403
    assert call("PUT", "/api/v1/fabric/launch/plan", {"apps": [{"id": "x", "name": "X", "state": "starting"}]}, headers=operator)[0] == 200
    assert call("GET", "/api/v1/fabric/state?since=999999999")[1]["data"]["launch_plan"]["apps"][0]["id"] == "x", "whether or not anything else changed"
    assert call("DELETE", "/api/v1/fabric/launch/plan", headers=operator)[0] == 200


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

            # The engine, through Fabric: authorized, and the older paths still answer and say so.
            engine = "/api/v1/fabric/engine"
            assert call("GET", f"{engine}/status")[0] == 200
            assert code(call("POST", f"{engine}/pause", {})) == "AUTHORIZATION_REQUIRED"
            assert code(call("POST", f"{engine}/pause", {}, token_b)) == "AUTHORIZATION_REQUIRED", "an application acts through its own route"
            assert code(call("POST", f"{engine}/start", {"seed": "1"}, headers={"X-DSTNS-Host": "observer"})) == "CLI_START_REQUIRED"
            assert call("POST", f"{engine}/pause", {}, headers=operator)[0] == 200
            assert call("POST", f"{engine}/play", {}, headers={"X-DSTNS-Host": "observer"})[0] == 200
            assert call("PUT", f"{engine}/tick-rate", {"tick_rate": 2}, headers=operator)[0] == 200
            legacy = call_raw(server, "GET", "/api/v1/playback/status")
            assert legacy[0] == 200 and legacy[2].get("Deprecation") == "true" and "Fabric API" in legacy[2].get("Warning", ""), legacy[2]
            assert legacy[1]["legacy"]["use"] == f"{engine}/status" and "legacy API" in legacy[1]["legacy"]["message"], legacy[1]
            current = call_raw(server, "GET", f"{engine}/status")
            assert "legacy" not in current[1] and "Deprecation" not in current[2], current[2]
            pause = call_raw(server, "POST", "/api/v1/playback/pause", {})
            assert pause[0] == 200 and pause[1]["legacy"]["use"] == f"{engine}/pause", pause

            security_checks(server, token_a, token_b, operator)

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
            # A store that has been changed behind the server's back is not trusted.
            server.stop()
            store = Path(tmp) / "fabric-apps.json"
            sealed = json.loads(store.read_text())
            sealed["apps"]["org.test.alpha"]["manifest"]["capabilities"].append("control.world")
            sealed["apps"]["org.test.alpha"]["granted"].append("control.world")
            store.write_text(json.dumps(sealed))
            server = Server(tmp)
            call = server.call
            assert call("GET", f"{alpha}/health", headers={"X-DSTNS-Operator": server.operator})[0] == 404, "what it said is not believed"
            assert call("GET", "/api/v1/fabric/security", headers={"X-DSTNS-Operator": server.operator})[1]["data"]["store"]["rejected"] is True
            assert (Path(tmp) / "fabric-apps.json.rejected").exists()
        finally:
            server.stop()
    print("fabric platform ok")


if __name__ == "__main__":
    main()
