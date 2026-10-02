# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""The terrain-tile downloader against a local tile server.

The engine decodes tiles; the script only has to put valid ones in the cache,
atomically, record where they came from, never re-fetch what it has, and fail
with a one-line reason the engine can show when it cannot.
"""
import http.server
import json
import subprocess
import sys
import tempfile
import threading
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/fetch_dem.py'


def png(width=64, height=64):
    raw = b''.join(b'\x00' + bytes([128, 0, 0] * width) for _ in range(height))

    def chunk(kind, data):
        return len(data).to_bytes(4, 'big') + kind + data + zlib.crc32(kind + data).to_bytes(4, 'big')

    header = width.to_bytes(4, 'big') + height.to_bytes(4, 'big') + bytes([8, 2, 0, 0, 0])
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


class Tiles(http.server.BaseHTTPRequestHandler):
    body = png()
    seen = None

    def do_GET(self):
        type(self).seen.append(self.path)
        if self.path.endswith('/404.png') or '/9/' in self.path:
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        body = type(self).body
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def serve(body):
    handler = type('Handler', (Tiles,), {'body': body, 'seen': []})
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, handler


def run(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=60)


class FetchDem(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def endpoint(self, server):
        return f'http://127.0.0.1:{server.server_port}/terrarium/{{z}}/{{x}}/{{y}}.png'

    def test_downloads_validates_and_records_provenance(self):
        server, handler = serve(png())
        try:
            result = run('--zoom', '13', '--tiles', '4400,2686,4401,2686', '--cache', str(self.cache), '--endpoint', self.endpoint(server))
            self.assertEqual(result.returncode, 0, result.stderr)
            for x in (4400, 4401):
                self.assertTrue((self.cache / 'terrarium/13' / str(x) / '2686.png').read_bytes().startswith(b'\x89PNG'))
            manifest = json.loads((self.cache / 'terrarium/manifest.json').read_text())
            self.assertIn('13/4400/2686', manifest['tiles'])
            self.assertIn('Mapzen', manifest['licence'])
            self.assertEqual(json.loads(result.stdout)['fetched'], 2)
            # Cached tiles are never fetched again.
            again = run('--zoom', '13', '--tiles', '4400,2686,4401,2686', '--cache', str(self.cache), '--endpoint', self.endpoint(server))
            self.assertEqual(json.loads(again.stdout)['fetched'], 0)
            self.assertEqual(len(handler.seen), 2)
            self.assertFalse(list(self.cache.rglob('*.part')))
        finally:
            server.shutdown()

    def test_a_non_png_answer_is_refused_and_not_cached(self):
        server, _ = serve(b'<html>rate limited</html>' * 10)
        try:
            result = run('--zoom', '13', '--tiles', '1,1,1,1', '--cache', str(self.cache), '--endpoint', self.endpoint(server),
                         '--retries', '0')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('fetch_dem:', result.stderr)
            self.assertIn('not a PNG', result.stderr)
            self.assertFalse(list(self.cache.rglob('*.png')))
        finally:
            server.shutdown()

    def test_bad_arguments_fail_with_a_reason(self):
        for args, message in ((['--zoom', '13', '--tiles', 'a,b,c,d'], 'four integers'),
                              (['--zoom', '20', '--tiles', '0,0,0,0'], 'zoom'),
                              (['--zoom', '13', '--tiles', '0,0,20,20'], 'more than')):
            with self.subTest(args=args):
                result = run(*args, '--cache', str(self.cache))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


if __name__ == '__main__':
    unittest.main()
