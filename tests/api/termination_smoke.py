#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Session termination against a real server and a deliberately stalled download."""
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
ROOT = Path(__file__).resolve().parents[2]

def processes():
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,stat='], text=True)
    return {int(p): (int(parent), state) for p, parent, state in (line.split() for line in rows.splitlines())}

def descendants(pid):
    table = processes(); found = {pid}
    while True:
        more = {p for p, (parent, _) in table.items() if parent in found}
        if more <= found: return found - {pid}
        found |= more

def wait_for(fn, seconds=12):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            result = fn()
            if result: return result
        except (OSError, ValueError): pass
        time.sleep(.05)
    raise AssertionError('condition did not become true')

class Termination(unittest.TestCase):
    def run_session(self, downloading):
        gate = threading.Event(); entered = threading.Event()
        class SlowMap(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                entered.set(); gate.wait(20)
                try: self.send_error(503)
                except OSError: pass
            def log_message(self, *args): pass
        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), SlowMap)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory(prefix='dstns-termination-') as tmp:
            with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            env = {**os.environ, 'DSTNS_OVERPASS_ENDPOINTS': f'http://127.0.0.1:{upstream.server_port}'}
            server = subprocess.Popen([os.environ.get('DSTNS_SERVER', str(ROOT/'build/dstns_server')), '--host', '127.0.0.1', '--port', str(port), '--logs', tmp, '--maps', tmp, '--map-cache', 'keep'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            children = set(); token = ''
            def call(route, data=None):
                request = urllib.request.Request(f'http://127.0.0.1:{port}'+route, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json', 'X-DSTNS-Operator': token})
                with urllib.request.urlopen(request, timeout=2) as response: return json.load(response)
            try:
                wait_for(lambda: call('/health')['ok'])
                token = (Path(tmp)/'operator.token').read_text().strip()
                config = {'seed': '723921', 'map': {'cache_dir': tmp} if downloading else {'osm_file': str(ROOT/'tests/fixtures/roads.osm.xml')}}
                call('/api/v1/playback/start', config)
                if downloading:
                    self.assertTrue(entered.wait(8), 'the real downloader reached the slow upstream')
                    children = descendants(server.pid)
                    self.assertTrue(children, 'a downloader child actually exists')
                    self.assertEqual(call('/api/v1/playback/status')['data']['lifecycle'], 'PREPARING')
                else:
                    wait_for(lambda: call('/api/v1/playback/status')['data']['lifecycle'] == 'RUNNING')
                self.assertTrue(call('/api/v1/system/terminate', {})['ok'])
                self.assertEqual(server.wait(timeout=6), 0)
                wait_for(lambda: not (children & processes().keys()))
                with self.assertRaises(OSError): call('/health')
            finally:
                gate.set(); upstream.shutdown(); upstream.server_close()
                if server.poll() is None: server.kill(); server.wait()
                # Cleanup is limited to PIDs proven to belong to this test.
                for pid in children & processes().keys():
                    try: os.kill(pid, 9)
                    except ProcessLookupError: pass
    def test_running_session(self): self.run_session(False)
    def test_download_in_flight(self): self.run_session(True)
if __name__ == '__main__': unittest.main()
