#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""An application directing the view, against a real server and a real world.

Everything asked for needs a person's grant, is checked against closed lists and ranges, is limited, is on
the record, and is gone when the application is. None of it is ever saved.
"""
import json
from pathlib import Path
import tempfile
import time

from fabric_platform_smoke import BASE, FIXTURE, Server, code, manifest


def main():
    with tempfile.TemporaryDirectory() as tmp:
        server = Server(tmp)
        try:
            call = server.call
            host = {"X-DSTNS-Operator": server.operator}
            status, body = call("POST", "/api/v1/playback/start", {"seed": "10775", "playback_duration_seconds": 600, "map": {"osm_file": FIXTURE}}, headers=host)
            assert status in (200, 201, 202), body
            end = time.monotonic() + 40
            while call("GET", "/api/v1/playback/status")[1]["data"]["lifecycle"] != "RUNNING":
                assert time.monotonic() < end, "the run did not start"
                time.sleep(0.1)

            status, body = call("POST", BASE, manifest("org.test.director", "ui.camera", "ui.layers", "ui.overlays"))
            assert status == 201, body
            token = body["data"]["token"]
            app = f"{BASE}/org.test.director"

            # Only a person gives this.
            for route, method, sent in ((f"{app}/view", "POST", {"action": "fit"}), (f"{app}/presentation", "PUT", {"layers": {"roads": False}})):
                refused = call(method, route, sent, token=token)
                assert refused[0] == 403 and code(refused) == "CAPABILITY_NOT_GRANTED", refused
            discovery = call("GET", "/api/v1/fabric/capabilities")[1]["data"]
            assert {"ui.camera", "ui.layers"} <= set(discovery["capabilities"]["needs_a_person"])
            assert discovery["path_styles"] == ["solid", "dashed", "dotted", "flow"]

            # An application that did not ask can't be given it.
            other = call("POST", BASE, manifest("org.test.other"))
            assert other[0] == 201
            refused = call("PUT", f"{BASE}/org.test.other/grants", {"capabilities": ["ui.camera"]}, headers=host)
            assert refused[0] == 400 and code(refused) == "CAPABILITY_NOT_REQUESTED", refused
            # Nor can it be given by an application.
            assert call("PUT", f"{app}/grants", {"capabilities": ["ui.camera", "ui.layers"]}, token=token)[0] == 403

            grant = call("PUT", f"{app}/grants", {"capabilities": ["ui.camera", "ui.layers", "ui.overlays"]}, headers=host)
            assert grant[0] == 200, grant

            # Without its token, nothing.
            assert call("POST", f"{app}/view", {"action": "fit"})[0] == 401

            # Moving the map: closed lists and ranges, and only what is known goes on.
            for wrong in ({}, {"action": "explode"}, {"action": 1}, {"action": "focus", "x_m": 1}, {"action": "focus", "x_m": "1", "y_m": 2},
                          {"action": "focus", "x_m": 1e12, "y_m": 0}, {"action": "focus", "x_m": 0, "y_m": 0, "span_m": 1}, {"action": "zoom", "factor": 5},
                          {"action": "zoom", "factor": 0.1}, {"action": "zoom"}, {"action": "node", "node": -1}, {"action": "edge", "edge": "1"},
                          {"action": "bounds", "min_x_m": 5, "min_y_m": 0, "max_x_m": 5, "max_y_m": 9}, []):
                refused = call("POST", f"{app}/view", wrong, token=token)
                assert refused[0] == 400 and code(refused) == "INVALID_VIEW", (wrong, refused)
            refused = call("POST", f"{app}/view", {"action": "node", "node": 99999999}, token=token)
            assert refused[0] == 422 and code(refused) == "NOT_ON_NETWORK", refused

            def settled(method, route, sent):
                for _ in range(40):
                    result = call(method, route, sent, token=token)
                    if result[0] != 429:
                        return result
                    time.sleep(0.25)
                raise AssertionError("never allowed")

            before = call("GET", "/api/v1/fabric/state")[1]["data"]["view_sequence"]
            asked = settled("POST", f"{app}/view", {"action": "focus", "x_m": 10, "y_m": 20, "span_m": 400, "duration_ms": 1, "script": "x"})
            assert asked[0] == 202, asked
            number = asked[1]["data"]["request"]
            state = call("GET", f"/api/v1/fabric/state?view_since={before}")[1]["data"]
            assert [item["request"] for item in state["view_requests"]] == [number], state["view_requests"]
            assert state["view_requests"][0]["view"] == {"action": "focus", "x_m": 10, "y_m": 20, "span_m": 400}, "nothing else goes through"
            assert state["view_requests"][0]["app"] == "org.test.director"
            assert call("GET", f"/api/v1/fabric/state?view_since={number}")[1]["data"]["view_requests"] == []
            # A request is for now. An observer coming back later isn't thrown around by it.
            time.sleep(5.2)
            assert call("GET", f"/api/v1/fabric/state?view_since={before}")[1]["data"]["view_requests"] == [], "stale requests are dropped"

            # The limit.
            statuses = [call("POST", f"{app}/view", {"action": "fit"}, token=token)[0] for _ in range(12)]
            assert 429 in statuses and statuses.count(202) >= 4, statuses

            # What became of it: only the observer says, and the application hears.
            refused = call("POST", f"{app}/view/outcome", {"request": 1, "outcome": "applied"}, token=token)
            assert refused[0] == 403, refused
            assert call("POST", f"{app}/view/outcome", {"request": 1, "outcome": "maybe"}, headers=host)[0] == 400
            assert call("POST", f"{app}/view/outcome", {"request": number, "outcome": "declined", "reason": "person_moved_the_map"}, headers=host)[0] == 200
            events = call("GET", f"{app}/events", token=token)[1]["data"]["items"]
            assert any(e["type"] == "view.declined" and e["data"]["request"] == number and e["data"]["reason"] == "person_moved_the_map" for e in events), events

            # Holding layers: a closed list, and strict values.
            for wrong in ([], {"layers": {"nonsense": True}}, {"layers": {"roads": 1}}, {"layers": []}, {"settings": {}}, {"places": {"BAD KIND": True}},
                          {"places": {"school": "no"}}, {"places": {f"k{i}": True for i in range(65)}}):
                refused = settled("PUT", f"{app}/presentation", wrong)
                assert refused[0] == 400 and code(refused) == "INVALID_PRESENTATION", (wrong, refused)

            held = settled("PUT", f"{app}/presentation", {"layers": {"weather": False}, "places": {"school": False}})
            assert held[0] == 200, held
            shown = call("GET", "/api/v1/fabric/state")[1]["data"]["presentation"]
            assert len(shown) == 1 and shown[0]["app"] == "org.test.director" and shown[0]["layers"] == {"weather": False} and shown[0]["places"] == {"school": False}, shown
            first = shown[0]["revision"]
            assert settled("PUT", f"{app}/presentation", {"layers": {"vehicles": True}})[0] == 200
            shown = call("GET", "/api/v1/fabric/state")[1]["data"]["presentation"]
            assert shown[0]["layers"] == {"vehicles": True} and shown[0]["places"] == {}, "it replaces what was held"
            assert shown[0]["revision"] > first, "and a person can tell it has asked again"
            # Reported even when nothing else has changed, or a held layer would outlast its application.
            revision = call("GET", "/api/v1/fabric/state")[1]["data"]["revision"]
            assert call("GET", f"/api/v1/fabric/state?since={revision}")[1]["data"]["presentation"] == shown

            # It lets go, and it is let go of.
            assert call("DELETE", f"{app}/presentation", token=token)[0] == 200
            assert call("GET", "/api/v1/fabric/state")[1]["data"]["presentation"] == []

            assert settled("PUT", f"{app}/presentation", {"layers": {"roads": False}})[0] == 200
            assert call("POST", f"{app}/suspend", headers=host)[0] == 200
            assert call("GET", "/api/v1/fabric/state")[1]["data"]["presentation"] == [], "suspended"
            refused = call("POST", f"{app}/view", {"action": "fit"}, token=token)
            assert refused[0] == 409 and code(refused) == "APP_NOT_ACTIVE", refused
            assert call("POST", f"{app}/resume", headers=host)[0] == 200
            assert call("GET", "/api/v1/fabric/state")[1]["data"]["presentation"] == [], "resuming does not bring it back unasked"

            assert settled("PUT", f"{app}/presentation", {"layers": {"roads": False}})[0] == 200
            assert call("PUT", f"{app}/grants", {"capabilities": ["ui.camera", "ui.overlays"]}, headers=host)[0] == 200
            assert call("GET", "/api/v1/fabric/state")[1]["data"]["presentation"] == [], "revoked"
            refused = call("PUT", f"{app}/presentation", {"layers": {"roads": False}}, token=token)
            assert refused[0] == 403, refused
            assert call("PUT", f"{app}/grants", {"capabilities": ["ui.camera", "ui.layers", "ui.overlays"]}, headers=host)[0] == 200
            assert call("GET", "/api/v1/fabric/state")[1]["data"]["presentation"] == [], "granting again does not bring it back either"

            # Asked for by a request nobody may see any more, once the grant has gone.
            before = call("GET", "/api/v1/fabric/state")[1]["data"]["view_sequence"]
            assert settled("POST", f"{app}/view", {"action": "fit"})[0] == 202
            assert call("PUT", f"{app}/grants", {"capabilities": ["ui.layers", "ui.overlays"]}, headers=host)[0] == 200
            assert call("GET", f"/api/v1/fabric/state?view_since={before}")[1]["data"]["view_requests"] == [], "revoked while it waited"
            assert call("PUT", f"{app}/grants", {"capabilities": ["ui.camera", "ui.layers", "ui.overlays"]}, headers=host)[0] == 200

            # Its own marks can choose how they look, within closed lists.
            topology = call("GET", "/api/v1/view/topology")[1]
            road = topology.get("data", topology)["edges"][0]
            for wrong in ({"color": "red"}, {"color": "#12345"}, {"color": "#12345g"}, {"color": 5}, {"style": "wavy"}, {"glow": "yes"}):
                feature = {"type": "route", "nodes": [road["from"], road["to"]], **wrong}
                refused = call("PUT", f"{app}/ui/line", {"id": "line", "slot": "overlay", "features": [feature]}, token=token)
                assert refused[0] == 400 and code(refused) == "INVALID_ELEMENT", (wrong, refused)
            refused = call("PUT", f"{app}/ui/dot", {"id": "dot", "slot": "overlay", "features": [{"type": "point", "x_m": 0, "y_m": 0, "color": "url(x)"}]}, token=token)
            assert refused[0] == 400, "a colour is checked on every kind of mark"
            allowed = call("PUT", f"{app}/ui/dot", {"id": "dot", "slot": "overlay", "features": [{"type": "point", "x_m": 0, "y_m": 0, "color": "auto"}, {"type": "circle", "x_m": 1, "y_m": 1, "color": "#37D7FF"}]}, token=token)
            assert allowed[0] == 200, allowed

            # All of it is on the record, refusals too, and the record holds together.
            audit = call("GET", "/api/v1/fabric/audit?limit=2000")[1]["data"]["items"]
            actions = {(e["action"], e["outcome"].split(":")[0]) for e in audit if e["app_id"] == "org.test.director"}
            assert {("view", "asked"), ("view", "refused"), ("presentation", "held"), ("presentation", "released"), ("presentation", "refused")} <= actions, actions
            verified = call("GET", "/api/v1/fabric/audit/verify", headers=host)[1]["data"]
            assert verified["intact"] is True, verified

            # None of it is ever saved.
            assert settled("PUT", f"{app}/presentation", {"layers": {"roads": False}})[0] == 200
            server.stop()
            saved = (Path(tmp) / "fabric-apps.json").read_text()
            assert "presentation" not in saved and "view_requests" not in saved, "held apart, and never kept"
            json.loads(saved)
            server = Server(tmp)
            state = server.call("GET", "/api/v1/fabric/state")[1]["data"]
            assert state["presentation"] == [] and state["view_requests"] == []
        finally:
            server.stop()
    print("fabric direction ok")


if __name__ == "__main__":
    main()
