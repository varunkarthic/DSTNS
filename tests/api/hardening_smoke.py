#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Request validation and cross-site protection against a real server."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
# Terrain comes from a synthetic surface or the cache in tests, never the network.
os.environ.setdefault("DSTNS_DEM_SOURCE", "flat")
ROOT = Path(__file__).resolve().parents[2]


class Hardening(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='dstns-hardening-')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); cls.port = sock.getsockname()[1]
        cls.server = subprocess.Popen(
            [os.environ.get('DSTNS_SERVER', str(ROOT / 'build/dstns_server')), '--host', '127.0.0.1',
             '--port', str(cls.port), '--logs', cls.tmp.name, '--maps', cls.tmp.name, '--map-cache', 'keep'],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            try:
                if cls.call('/health')[1]['ok']: break
            except OSError:
                time.sleep(.05)
        cls.token = (Path(cls.tmp.name) / 'operator.token').read_text().strip()
        cls.call('/api/v1/playback/start', 'POST', {'seed': '723921', 'map': {'osm_file': str(ROOT / 'tests/fixtures/roads.osm.xml')}},
                 {'X-DSTNS-Operator': cls.token})
        end = time.monotonic() + 15
        while time.monotonic() < end and cls.call('/api/v1/playback/status')[1]['data']['lifecycle'] != 'RUNNING':
            time.sleep(.05)

    @classmethod
    def tearDownClass(cls):
        if cls.server.poll() is None:
            cls.server.kill(); cls.server.wait()
        cls.tmp.cleanup()

    @classmethod
    def call(cls, route, method='GET', data=None, headers=None):
        request = urllib.request.Request(
            f'http://127.0.0.1:{cls.port}' + route, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                try: return error.code, json.load(error)
                except ValueError: return error.code, {}

    def test_cross_site_state_change_is_refused(self):
        code, body = self.call('/api/v1/playback/pause', 'POST', {}, {'Origin': 'https://attacker.example'})
        self.assertEqual(code, 403)
        self.assertEqual(body['error']['code'], 'CROSS_ORIGIN_FORBIDDEN')
        code, _ = self.call('/api/v1/system/terminate', 'POST', {}, {'Origin': 'null'})
        self.assertEqual(code, 403)
        self.assertIsNone(self.server.poll(), 'the server survived a forged terminate')

    def test_same_origin_and_originless_requests_pass(self):
        code, _ = self.call('/api/v1/playback/pause', 'POST', {}, {'Origin': f'http://127.0.0.1:{self.port}'})
        self.assertEqual(code, 200)
        code, _ = self.call('/api/v1/playback/play', 'POST', {})
        self.assertEqual(code, 200)

    def test_dns_rebinding_host_is_refused_on_loopback(self):
        # After DNS rebinding the attacker's hostname is in both Origin and Host,
        # so the same-origin check alone passes; the Host check must refuse it.
        for method, route in (('GET', '/api/v1/playback/status'), ('POST', '/api/v1/playback/pause')):
            code, body = self.call(route, method, {} if method == 'POST' else None,
                                   {'Host': 'rebind.attacker.example:8090', 'Origin': 'http://rebind.attacker.example:8090'})
            self.assertEqual(code, 421, (route, body))
            self.assertEqual(body['error']['code'], 'HOST_NOT_ALLOWED')

    def test_loopback_names_and_ip_literals_are_accepted(self):
        for host in (f'127.0.0.1:{self.port}', f'localhost:{self.port}', f'app.localhost:{self.port}',
                     f'[::1]:{self.port}', '10.1.2.3:8090'):
            code, _ = self.call('/api/v1/playback/status', headers={'Host': host})
            self.assertEqual(code, 200, host)

    def cors_header(self, origin):
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}/api/v1/playback/status', headers={'Origin': origin})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, response.headers.get('Access-Control-Allow-Origin'), response.headers.get('Vary')

    def test_foreign_origins_are_not_granted_cors(self):
        # The response is still produced (a GET is harmless), but without the
        # header a browser will not let the foreign page read it.
        code, allowed, vary = self.cors_header('https://elsewhere.example')
        self.assertEqual(code, 200)
        self.assertIsNone(allowed)
        self.assertEqual(vary, 'Origin')

    def test_own_origin_is_granted_cors(self):
        own = f'http://127.0.0.1:{self.port}'
        _, allowed, _ = self.cors_header(own)
        self.assertEqual(allowed, own)

    def test_terminate_cannot_be_triggered_by_get(self):
        for route in ('/terminate', '/api/v1/system/terminate'):
            code, _ = self.call(route)
            self.assertEqual(code, 404, route)
        self.assertIsNone(self.server.poll())

    def test_identifiers_do_not_wrap(self):
        # 2^32 + 0 would truncate to edge 0 under a narrowing cast.
        code, body = self.call('/api/v1/control/edges/4294967296/override', 'POST', {'closed': True})
        self.assertEqual(code, 400, body)
        code, _ = self.call('/api/v1/view/nodes/99999999999999999999')
        self.assertEqual(code, 400)

    def test_out_of_day_seek_is_rejected(self):
        code, body = self.call('/api/v1/playback/seek', 'POST', {'target_time': 999999})
        self.assertEqual(code, 400, body)

    def test_negative_query_numbers_are_rejected(self):
        code, _ = self.call('/api/v1/news?since_news_id=-1')
        self.assertEqual(code, 400)
        code, _ = self.call('/api/v1/view/logs/api?limit=-5')
        self.assertEqual(code, 400)

    def test_weather_duration_is_bounded(self):
        code, _ = self.call('/api/v1/control/events/weather', 'POST', {'epicenter_node': 0, 'duration_virtual_minutes': -10})
        self.assertEqual(code, 400)
        code, _ = self.call('/api/v1/control/events/weather', 'POST', {'epicenter_node': 0, 'duration_virtual_minutes': 1e12})
        self.assertEqual(code, 400)

    def test_surge_parameters_are_bounded(self):
        code, _ = self.call('/api/v1/control/events/surge', 'POST', {'node_id': 0, 'factor': -3})
        self.assertEqual(code, 400)

    def test_history_count_does_not_wrap(self):
        # -1 read as unsigned is 4294967295: everything would be undone.
        for count in (-1, 0):
            code, body = self.call('/api/v1/control/undo', 'POST', {'count': count})
            self.assertEqual(code, 400, body)
            code, _ = self.call('/api/v1/control/redo', 'POST', {'count': count})
            self.assertEqual(code, 400)

    def test_sumo_period_is_validated(self):
        code, _ = self.call('/api/v1/system/sumo-simulate', 'POST', {'begin_s': 3600, 'end_s': 60})
        self.assertEqual(code, 400)


if __name__ == '__main__':
    unittest.main()
