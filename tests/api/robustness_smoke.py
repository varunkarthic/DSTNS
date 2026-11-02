#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Hostile values at every route that takes any, against a real server and a real world.

A wrong request gets a 4xx with a code. It never gets a 5xx, and it never takes the server down.
"""
import hashlib
import hmac
import http.client
import json
import secrets
import tempfile
import time

from fabric_platform_smoke import BASE, FIXTURE, Server

VALUES = [None, True, -1, 0, 1, 1.5, 1e308, -1e308, 2**64, -(2**63), "", "x", "../../etc/passwd", "\u0000", "퟿" * 300, [], [[]], {}, {"a": {}}, [1, 2, 3]]
DEEP = "[" * 200000 + "]" * 200000
DEEP_OBJECT = '{"a":' * 100000 + "1" + "}" * 100000


def raw(server, method, route, payload, headers=None):
    """Bytes as they are, for what json.dumps would not send."""
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=30)
    try:
        connection.request(method, route, payload, {"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        response.read()
        return response.status
    finally:
        connection.close()


def assert_protections(server, token, host):
    """Each of these was once possible."""
    call = server.call
    # Only the operator writes outside data/.
    for directory in ("/tmp/dstns-nope", "../dstns-nope", "data/../../dstns-nope", "logs/x", ""):
        result = call("POST", "/api/v1/export/sumo", {"directory": directory})
        assert result[0] == 403 and result[1]["error"]["code"] == "DIRECTORY_NOT_ALLOWED", (directory, result)
    # Nothing may frame the observer, or sniff what it serves.
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
    connection.request("GET", "/")
    page = connection.getresponse()
    page.read()
    assert page.getheader("X-Frame-Options") == "DENY" and page.getheader("X-Content-Type-Options") == "nosniff"
    if page.getheader("Content-Security-Policy"):
        assert "frame-ancestors 'none'" in page.getheader("Content-Security-Policy")
    connection.close()

    # A response is signed only for a request that really was: no signatures for the asking.
    app_id = "org.test.signed"
    made = call("POST", BASE, {"id": app_id, "name": "Signed", "version": "1.0.0", "security": {"require_signatures": True}})[1]["data"]
    route = f"{BASE}/{app_id}"
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
    connection.request("GET", route, headers={"X-DSTNS-Signature": "0" * 64, "X-DSTNS-Nonce": "chosen-by-me", "X-DSTNS-Timestamp": "1"})
    answer = connection.getresponse()
    answer.read()
    assert answer.getheader("X-DSTNS-Response-Signature") is None, "a forged request gets nothing signed"
    connection.close()

    def signed(method, target, payload=None):
        text = "" if payload is None else json.dumps(payload)
        moment, nonce = str(int(time.time())), secrets.token_hex(8)
        digest = hashlib.sha256(text.encode()).hexdigest()
        signature = hmac.new(made["signing_key"].encode(), f"{method}\n{target}\n{moment}\n{nonce}\n{digest}".encode(), hashlib.sha256).hexdigest()
        connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
        connection.request(method, target, text or None, {"Content-Type": "application/json", "Authorization": f"Bearer {made['token']}", "X-DSTNS-Timestamp": moment, "X-DSTNS-Nonce": nonce, "X-DSTNS-Signature": signature})
        reply = connection.getresponse()
        reply.read()
        connection.close()
        return reply

    good = signed("POST", f"{route}/heartbeat")
    assert good.status == 200 and good.getheader("X-DSTNS-Response-Signature"), "a real one does"
    # Nor can a stolen token turn signing off by registering again without it.
    stolen = call("POST", BASE, {"id": app_id, "name": "Signed", "version": "2.0.0"}, token=made["token"])
    assert stolen[0] == 401 and stolen[1]["error"]["code"] == "SIGNATURE_REQUIRED", stolen
    assert signed("POST", BASE, {"id": app_id, "name": "Signed", "version": "2.0.0", "security": {"require_signatures": True}}).status == 201

    # Taking up an ID someone left doesn't hand over what it kept, or what it was sent.
    token_a = call("POST", BASE, {"id": "org.test.leaves", "name": "Leaves", "version": "1.0.0", "capabilities": ["storage"]})[1]["data"]["token"]
    place = f"{BASE}/org.test.leaves"
    assert call("PUT", f"{place}/storage/secret", {"value": "mine"}, token=token_a)[0] == 200
    assert call("DELETE", place, token=token_a)[0] == 200
    token_b = call("POST", BASE, {"id": "org.test.leaves", "name": "Leaves", "version": "1.0.0", "capabilities": ["storage"]})[1]["data"]["token"]
    assert token_b != token_a and call("GET", f"{place}/storage/secret", token=token_b)[0] == 404, "storage is the application's own"
    assert call("GET", f"{place}/storage", token=token_a)[0] == 401, "and the old token is finished"

    # The record says what was asked, not everything sent.
    assert call("POST", f"{BASE}/org.test.fuzz/control", {"action": "pause", "params": {"junk": "x" * 100000}}, token=token)[0] in (200, 400, 409)
    last = call("GET", "/api/v1/fabric/audit?limit=1")[1]["data"]["items"][-1]
    assert last["params"] == {"truncated": True}, last

    # Places for applications can't be used up for good by programs that have gone.
    for n in range(70):
        identity = f"org.test.gone{n}"
        made_n = call("POST", BASE, {"id": identity, "name": f"Gone {n}", "version": "1.0.0"})
        assert made_n[0] == 201, (n, made_n)
        assert call("DELETE", f"{BASE}/{identity}", token=made_n[1]["data"]["token"])[0] == 200


def main():
    with tempfile.TemporaryDirectory() as tmp:
        server = Server(tmp)
        try:
            call = server.call
            host = {"X-DSTNS-Operator": server.operator}
            status = call("POST", "/api/v1/playback/start", {"seed": "10775", "playback_duration_seconds": 600, "map": {"osm_file": FIXTURE}}, headers=host)
            assert status[0] == 202, status
            end = time.monotonic() + 40
            while call("GET", "/api/v1/playback/status")[1]["data"]["lifecycle"] != "RUNNING":
                assert time.monotonic() < end
                time.sleep(0.1)
            capabilities = ["ui.camera", "ui.layers", "ui.overlays", "ui.panels", "ui.notifications", "settings", "sim.read", "storage", "apps.messages", "control.playback", "control.events"]
            token = call("POST", BASE, {"id": "org.test.fuzz", "name": "Fuzz", "version": "1.0.0", "capabilities": capabilities})[1]["data"]["token"]
            assert call("PUT", f"{BASE}/org.test.fuzz/grants", {"capabilities": capabilities}, headers=host)[0] == 200
            app = f"{BASE}/org.test.fuzz"

            # Field by field: every value in every field a route reads.
            routes = [
                ("POST", "/api/v1/control/events/weather", ["epicenter_node", "intensity", "radius_m", "duration_virtual_minutes", "flood_gain"], {"epicenter_node": 0}),
                ("POST", "/api/v1/control/events/traffic", ["target", "congestion_pressure"], {"target": {"type": "edge", "id": 0}, "congestion_pressure": 0.5}),
                ("POST", "/api/v1/control/events/surge", ["node_id", "factor", "radius_m", "duration_s"], {"node_id": 0}),
                ("PUT", "/api/v1/control/edges/0", ["speed_multiplier", "capacity_multiplier", "closed"], {}),
                ("PUT", "/api/v1/control/tick-rate", ["tick_rate"], {"tick_rate": 1}),
                ("POST", "/api/v1/control/day", ["day"], {"day": 1}),
                ("PUT", "/api/v1/control/modules/traffic", ["enabled"], {"enabled": True}),
                ("POST", "/api/v1/control/undo", ["count"], {}),
                ("POST", "/api/v1/control/redo", ["count"], {}),
                ("POST", "/api/v1/playback/seek", ["target_time", "play"], {"target_time": 60}),
                ("POST", "/api/v1/playback/step", ["seconds"], {}),
                ("POST", "/api/v1/playback/play", ["rate", "tick_rate"], {}),
                ("POST", "/api/v1/playback/pause", ["reason"], {}),
                ("POST", "/api/v1/system/backpressure", ["virtual_lag_s", "client_frame_s", "since_poll_s", "away"], {}),
                ("POST", "/api/v1/system/observer", ["waiting"], {}),
                ("POST", "/api/v1/export/sumo", ["directory"], {}),
                ("POST", "/api/v1/system/sumo-simulate", ["begin_s", "end_s"], {"directory": "data/sumo_fuzz"}),
                ("POST", BASE, ["id", "name", "version", "capabilities", "ui", "settings", "lease_s", "frame_origins", "security"], {"id": "org.test.other", "name": "Other", "version": "1.0.0"}),
                ("PUT", f"{app}/state", ["state", "detail"], {"state": "active"}),
                ("PUT", f"{app}/ui/thing", ["slot", "title", "widgets", "features", "motion", "frame"], {"slot": "panel"}),
                ("POST", f"{app}/notifications", ["title", "body", "severity", "actions"], {"title": "x"}),
                ("PUT", f"{app}/settings", ["anything"], {}),
                ("PUT", f"{app}/subscriptions", ["topics"], {"topics": []}),
                ("PUT", f"{app}/timers/t", ["at_s", "every_s", "data"], {"at_s": 10}),
                ("PUT", f"{app}/storage/k", ["value"], {"value": 1}),
                ("POST", f"{app}/messages", ["to", "type", "data"], {"to": "org.test.fuzz"}),
                ("PUT", f"{app}/stops", ["nodes"], {"nodes": [0]}),
                ("POST", f"{app}/view", ["action", "x_m", "y_m", "span_m", "node", "edge", "factor"], {"action": "focus", "x_m": 0, "y_m": 0}),
                ("PUT", f"{app}/presentation", ["layers", "places"], {}),
                ("POST", f"{app}/control", ["action", "params"], {"action": "pause"}),
                ("PUT", f"{app}/launch", ["commands", "cwd", "env", "ready"], {"commands": ["x"]}),
            ]
            problems = []
            for method, route, fields, base in routes:
                for field in fields:
                    for value in VALUES:
                        sent = {**base, field: value}
                        try:
                            # Never as the operator where a path is taken: that is allowed to write wherever it says.
                            as_operator = not route.startswith(app) and "sumo" not in route
                            code = call(method, route, sent, token=token, headers=host if as_operator else None)[0]
                        except Exception as error:  # noqa: BLE001
                            problems.append((method, route, field, repr(value)[:40], repr(error)[:80]))
                            continue
                        # 503 says a tool outside the server failed, which is not a fault in the request's handling.
                        if code >= 500 and code != 503:
                            problems.append((method, route, field, repr(value)[:40], code))
                # Whatever those left behind, the run carries on.
                call("POST", "/api/v1/playback/pause", {})

            # Bodies that are not what they say.
            for route in ("/api/v1/control/undo", BASE, f"{app}/storage/k", f"{app}/ui/thing"):
                method = "PUT" if route.endswith(("/k", "/thing")) else "POST"
                for payload in (b"", b"{", b"\xff\xfe", b"null", b"[]", b"1", b'"x"', DEEP.encode(), DEEP_OBJECT.encode()):
                    code = raw(server, method, route, payload, {"Authorization": f"Bearer {token}"})
                    if code >= 500:
                        problems.append((method, route, payload[:12], code))
            try:
                assert raw(server, "POST", BASE, b" " * (17 * 1024 * 1024)) == 413, "a body has a limit"
            except ConnectionError:
                pass  # It may also close the connection without waiting for the rest.

            # Query strings and path segments.
            for route in ("/api/v1/view/nodes?limit=-1", "/api/v1/view/nodes?offset=99999999999999999999", "/api/v1/view/edges/99999999999", "/api/v1/view/places?kind=%00", "/api/v1/news?limit=x",
                          "/api/v1/view/event-queue?view=x", "/api/v1/fabric/state?since=x", "/api/v1/fabric/audit?limit=-1", f"{app}/events?since=-1", "/assets/../../../../etc/passwd", "/assets/%2e%2e/%2e%2e/etc/passwd", "/media/../CMakeLists.txt"):
                code = raw(server, "GET", route, None, {"Authorization": f"Bearer {token}"})
                if code >= 500 or (route.startswith(("/assets", "/media")) and code == 200):
                    problems.append(("GET", route, code))

            assert_protections(server, token, host)
            assert not problems, "\n".join(map(str, problems[:60])) + f"\n{len(problems)} in all"
            assert server.process.poll() is None, "the server is still running"
            assert call("GET", "/health")[0] == 200
        finally:
            server.stop()
    print("robustness ok")


if __name__ == "__main__":
    main()
