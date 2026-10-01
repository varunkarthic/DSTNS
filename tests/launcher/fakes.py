# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Test doubles: a fake DSTNS HTTP server and an isolated repository layout."""
from __future__ import annotations

import json
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class FakeServer:
    """Answers the routes the launcher uses, with scriptable behaviour."""

    def __init__(self, *, current: bool = True, start_code: int = 202, preparation_error: str = "",
                 lifecycle_after_start: str = "RUNNING", topology_source: str = "OpenStreetMap") -> None:
        self.current = current
        self.start_code = start_code
        self.preparation_error = preparation_error
        self.lifecycle = "IDLE"
        self.lifecycle_after_start = lifecycle_after_start
        self.topology_source = topology_source
        self.requests: list[tuple[str, str, dict | None]] = []
        self.terminated = False
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, code: int, body: dict) -> None:
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                fake.requests.append(("GET", self.path, None))
                path = self.path.split("?")[0]
                if path == "/health":
                    body = {"ok": True, "service": "dstns", "lifecycle": fake.lifecycle}
                    if fake.current:
                        body["observer_ui_version"] = "observer-v2"
                    return self.reply(200, body)
                if path == "/api/v1/playback/status":
                    return self.reply(200, {"run_id": "run_test", "seed": "42",
                                            "clock": {"simulated_current_time": "01:00:00", "virtual_day_seconds": 3600,
                                                      "simulation_percentage": 3600 / 86400, "tick_rate": 1},
                                            "data": {"lifecycle": fake.lifecycle, "day": 0,
                                                     "preparation_error": fake.preparation_error}})
                if path == "/api/v1/system/map-status":
                    return self.reply(200, {"data": {"active": False}})
                if path == "/api/v1/view/topology":
                    return self.reply(200, {"data": {"source": fake.topology_source, "nodes": [{}] * 5, "edges": [{}] * 8,
                                                     "features": [{}] * 3,
                                                     "location": {"city": "Testville", "country": "Nowhere",
                                                                  "anchor_lat": 1.5, "anchor_lon": 2.5, "downloaded": False}}})
                if path == "/api/v1/view/traffic":
                    return self.reply(200, {"clock": {"target_virtual_rate": 24},
                                            "data": {"vehicle_count": 10, "halting_vehicle_count": 2,
                                                     "mean_vehicle_speed_mps": 10, "flooded_edge_count": 0,
                                                     "closed_edge_count": 1, "active_dws_events": 0}})
                if path == "/api/v1/view/congestion":
                    return self.reply(200, {"data": {"current": 12.5, "average": 10.0}})
                if path == "/api/v1/system/observer":
                    return self.reply(200, {"data": {"loaded": True}})
                return self.reply(404, {"error": {"code": "NOT_FOUND", "message": "no such route"}})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                fake.requests.append(("POST", self.path, body))
                if self.path == "/api/v1/playback/start":
                    if fake.start_code != 202:
                        return self.reply(fake.start_code, {"error": {"code": "MAP_FETCH_FAILED" if fake.start_code == 503 else "BAD",
                                                                      "message": "could not fetch the map"}})
                    fake.lifecycle = "IDLE" if fake.preparation_error else fake.lifecycle_after_start
                    return self.reply(202, {"data": {"accepted": True}})
                if self.path in ("/api/v1/playback/pause", "/api/v1/playback/play", "/api/v1/playback/seek"):
                    fake.lifecycle = "PAUSED" if self.path.endswith("pause") else "RUNNING"
                    return self.reply(200, {"data": {"lifecycle": fake.lifecycle}})
                if self.path == "/api/v1/system/terminate":
                    fake.terminated = True
                    threading.Thread(target=fake.http.shutdown, daemon=True).start()
                    return self.reply(200, {"status": "TERMINATING"})
                return self.reply(404, {"error": {"code": "NOT_FOUND", "message": "no such route"}})

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.http.server_address[1]
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)

    def __enter__(self) -> "FakeServer":
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        if not self.terminated:
            self.http.shutdown()
        self.http.server_close()

    def posted(self, route: str) -> list[dict]:
        return [body or {} for method, path, body in self.requests if method == "POST" and path == route]


class Workspace:
    """A temporary copy of the files the launcher reads, so tests never touch the real ones."""

    def __init__(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="dstns-launcher-")
        self.root = Path(self.tmp.name)
        (self.root / "config").mkdir()
        for name in ("defaults.json", "ui-config.json"):
            shutil.copy(ROOT / "config" / name, self.root / "config" / name)
        shutil.copy(ROOT / "CMakeLists.txt", self.root / "CMakeLists.txt")
        (self.root / "data" / "fixtures").mkdir(parents=True)
        shutil.copy(ROOT / "tests" / "fixtures" / "roads.osm.xml", self.root / "data" / "fixtures" / "roads.osm.xml")
        (self.root / "logs").mkdir()

    @property
    def paths(self):
        from dstns_launcher.core.paths import Paths

        return Paths(self.root)

    def cleanup(self) -> None:
        self.tmp.cleanup()
