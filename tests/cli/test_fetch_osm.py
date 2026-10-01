# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The map downloader against a local Overpass.

A single volunteer-run Overpass mirror refusing connections, shedding load or
timing out must not end a run, so the fetcher fails over between mirrors. These
tests stand up their own endpoints: a closed port, a mirror that rate limits,
and one that serves a map, and check what the operator is told when none of
them answers.
"""
import http.server
import json
import socket
import subprocess
import sys
import threading
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/fetch_osm.py'

MAP = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
 <node id="1" lat="52.5000" lon="13.4000"/>
 <node id="2" lat="52.5010" lon="13.4010"/>
 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
</osm>
"""


class Overpass(http.server.BaseHTTPRequestHandler):
    """Serves `script` responses in order: an int is a status, bytes are a body."""

    script = None
    seen = None

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length') or 0))
        type(self).seen.append(self.path)
        step = type(self).script.pop(0) if type(self).script else MAP
        if isinstance(step, int):
            self.send_response(step)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/xml')
        self.send_header('Content-Length', str(len(step)))
        self.end_headers()
        self.wfile.write(step)

    def log_message(self, *_args):
        pass


def serve(script):
    handler = type('Handler', (Overpass,), {'script': list(script), 'seen': []})
    server = http.server.HTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, handler


def closed_port():
    """A port with nothing listening, so a connection to it is refused."""
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def fetch(output, endpoints, extra=()):
    args = [sys.executable, str(SCRIPT), '--bbox', '52.499,13.399,52.502,13.402', '--output', str(output), '--retries', '0']
    for endpoint in endpoints:
        args += ['--endpoint', endpoint]
    return subprocess.run(args + list(extra), capture_output=True, text=True, cwd=ROOT)


class FetchOsmTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / 'tile.osm.xml'
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        self.tmp.cleanup()

    def endpoint(self, script=()):
        server, handler = serve(script)
        self.servers.append(server)
        return f'http://127.0.0.1:{server.server_address[1]}/api/interpreter', handler

    def test_downloads_and_records_its_source(self):
        url, handler = self.endpoint()
        result = fetch(self.out, [url])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.out.read_bytes(), MAP)
        manifest = json.loads(self.out.with_suffix('.manifest.json').read_text())
        self.assertEqual(manifest['endpoint'], url)
        self.assertEqual(manifest['bytes'], len(MAP))
        self.assertEqual(len(handler.seen), 1)
        # Nothing is left behind for the progress reader.
        self.assertFalse(self.out.with_name(self.out.name + '.progress').exists())

    def test_fails_over_when_a_mirror_refuses_connections(self):
        dead = f'http://127.0.0.1:{closed_port()}/api/interpreter'
        url, handler = self.endpoint()
        result = fetch(self.out, [dead, url])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.out.read_bytes(), MAP)
        self.assertEqual(len(handler.seen), 1, 'the healthy mirror served the map')
        self.assertEqual(json.loads(self.out.with_suffix('.manifest.json').read_text())['endpoint'], url)

    def test_fails_over_when_a_mirror_sheds_load(self):
        busy, _ = self.endpoint([429])
        url, handler = self.endpoint()
        result = fetch(self.out, [busy, url])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(handler.seen), 1)

    def test_retries_the_same_mirror_before_moving_on(self):
        flaky, handler = self.endpoint([503, MAP])
        result = fetch(self.out, [flaky], extra=['--retries', '1'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(handler.seen), 2, 'the mirror was retried, not abandoned')

    def test_reports_every_endpoint_when_the_host_is_offline(self):
        first, second = closed_port(), closed_port()
        result = fetch(self.out, [f'http://127.0.0.1:{first}/api', f'http://127.0.0.1:{second}/api'])
        self.assertEqual(result.returncode, 1)
        message = result.stderr.strip()
        # One line, naming both endpoints, saying what to do about it.
        self.assertEqual(len(message.splitlines()), 1, message)
        self.assertIn('no route to Overpass from this host', message)
        self.assertIn(str(first), message)
        self.assertIn(str(second), message)
        self.assertIn('DSTNS_OVERPASS_ENDPOINTS', message)
        self.assertIn('--osm-file', message)
        self.assertFalse(self.out.exists())

    def test_distinguishes_a_busy_overpass_from_an_unreachable_one(self):
        busy, _ = self.endpoint([429])
        result = fetch(self.out, [busy])
        self.assertEqual(result.returncode, 1)
        self.assertIn('every Overpass endpoint failed', result.stderr)
        self.assertIn('429', result.stderr)
        self.assertNotIn('no route', result.stderr)

    def test_reads_endpoints_from_the_environment(self):
        url, handler = self.endpoint()
        args = [sys.executable, str(SCRIPT), '--bbox', '52.499,13.399,52.502,13.402', '--output', str(self.out)]
        env = {'PATH': '/usr/bin:/bin', 'DSTNS_OVERPASS_ENDPOINTS': f'http://127.0.0.1:{closed_port()}/api, {url}'}
        result = subprocess.run(args, capture_output=True, text=True, cwd=ROOT, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(handler.seen), 1)

    def test_rejects_a_response_that_is_not_a_map(self):
        url, _ = self.endpoint([b'<osm><remark>runtime error: Query timed out</remark></osm>'])
        result = fetch(self.out, [url])
        self.assertEqual(result.returncode, 1)
        self.assertIn('Query timed out', result.stderr)
        self.assertFalse(self.out.exists())

    def test_rejects_an_empty_tile(self):
        url, _ = self.endpoint([b'<osm version="0.6"></osm>'])
        result = fetch(self.out, [url])
        self.assertEqual(result.returncode, 1)
        self.assertIn('no roads found', result.stderr)
        self.assertFalse(self.out.exists())


if __name__ == '__main__':
    unittest.main()
