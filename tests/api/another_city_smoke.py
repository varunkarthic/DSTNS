#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Trying again after a failed map download goes somewhere else, and uses no network."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory(prefix='dstns-another-city-') as tmp:
        tmp = Path(tmp)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        server = subprocess.Popen(
            [os.environ.get('DSTNS_SERVER', str(ROOT / 'build/dstns_server')), '--host', '127.0.0.1', '--port', str(port),
             '--logs', str(tmp), '--maps', str(tmp / 'maps'), '--map-cache', 'keep'],
            cwd=ROOT, env={**os.environ, 'DSTNS_FETCHER': '/usr/bin/false'},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def call(route, data=None):
            token = (tmp / 'operator.token').read_text().strip()
            request = urllib.request.Request(f'http://127.0.0.1:{port}{route}',
                                             data=None if data is None else json.dumps(data).encode(),
                                             headers={'Content-Type': 'application/json', 'X-DSTNS-Operator': token})
            with urllib.request.urlopen(request, timeout=5) as response:
                return json.load(response)

        def failed_city():
            end = time.monotonic() + 8
            while time.monotonic() < end:
                status = call('/api/v1/playback/status')['data']
                if status['lifecycle'] == 'IDLE' and status['preparation_error']:
                    return re.search(r'failed for (.+?) \(', status['preparation_error']).group(1)
                time.sleep(0.02)
            raise AssertionError('the download did not fail')

        try:
            end = time.monotonic() + 8
            while True:
                try:
                    call('/health')
                    break
                except OSError:
                    assert time.monotonic() < end, 'the server did not start'
                    time.sleep(0.05)
            call('/api/v1/playback/start', {'seed': '42', 'map': {'osm_file': 'auto'}})
            city = failed_city()
            for _ in range(8):
                call('/api/v1/world/regenerate', {})
                # Each attempt must have begun before its result is read.
                following = failed_city()
                assert following != city, f'tried {city} again'
                city = following
            print('Another city: every retry after a failed download chose a different city')
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    main()
