#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""A world waits for an observer showing its start-up, and for nobody else."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
RUN = {'seed': '12345', 'playback_duration_seconds': 3600, 'map': {'osm_file': 'tests/fixtures/roads.osm.xml'}}


def main():
    with tempfile.TemporaryDirectory(prefix='dstns-observer-hold-') as tmp:
        tmp = Path(tmp)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        server = subprocess.Popen(
            [os.environ.get('DSTNS_SERVER', str(ROOT / 'build/dstns_server')), '--host', '127.0.0.1', '--port', str(port), '--logs', str(tmp)],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def call(route, data=None):
            token = (tmp / 'operator.token').read_text().strip()
            request = urllib.request.Request(f'http://127.0.0.1:{port}{route}',
                                             data=None if data is None else json.dumps(data).encode(),
                                             headers={'Content-Type': 'application/json', 'X-DSTNS-Operator': token})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)

        def status():
            return call('/api/v1/playback/status')['data']

        def until(check, seconds=8, keep=None):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if keep:
                    keep()
                value = status()
                if check(value):
                    return value
                time.sleep(0.05)
            raise AssertionError(f'timed out at {status()}')

        def restart():
            call('/api/v1/playback/reset', {})
            until(lambda s: s['lifecycle'] in ('IDLE', 'STOPPED'))
            call('/api/v1/playback/start', RUN)

        try:
            end = time.monotonic() + 8
            while True:
                try:
                    call('/health')
                    break
                except OSError:
                    assert time.monotonic() < end, 'the server did not start'
                    time.sleep(0.05)

            # Nobody watching: it just runs.
            call('/api/v1/playback/start', RUN)
            running = until(lambda s: s['lifecycle'] == 'RUNNING')
            assert running['observer_hold'] is False

            # An observer arriving during a run changes nothing.
            call('/api/v1/system/observer', {'waiting': True})
            time.sleep(0.2)
            assert status()['lifecycle'] == 'RUNNING'
            call('/api/v1/system/observer', {'waiting': False})

            # Watching: it waits at its first second, and goes when the observer is ready.
            call('/api/v1/playback/reset', {})
            until(lambda s: s['lifecycle'] in ('IDLE', 'STOPPED'))
            ping = lambda: call('/api/v1/system/observer', {'waiting': True})
            ping()
            call('/api/v1/playback/start', RUN)
            held = until(lambda s: s['lifecycle'] == 'PAUSED', keep=ping)
            assert held['observer_hold'] is True
            first = held.get('simulated_seconds')
            for _ in range(10):
                ping()
                time.sleep(0.1)
            after = status()
            assert after['lifecycle'] == 'PAUSED' and after.get('simulated_seconds') == first
            call('/api/v1/system/observer', {'waiting': False})
            released = until(lambda s: s['lifecycle'] == 'RUNNING')
            assert released['observer_hold'] is False

            # The observer goes away while it waits: the engine carries on by itself.
            call('/api/v1/playback/reset', {})
            until(lambda s: s['lifecycle'] in ('IDLE', 'STOPPED'))
            ping()
            call('/api/v1/playback/start', RUN)
            until(lambda s: s['lifecycle'] == 'PAUSED', keep=ping)
            gone = time.monotonic()
            until(lambda s: s['lifecycle'] == 'RUNNING', seconds=8)
            assert 2 < time.monotonic() - gone < 7, 'resumed about when the lease ran out'

            # Pausing during the wait is a real pause, and it is not undone by the observer leaving.
            call('/api/v1/playback/reset', {})
            until(lambda s: s['lifecycle'] in ('IDLE', 'STOPPED'))
            ping()
            call('/api/v1/playback/start', RUN)
            until(lambda s: s['lifecycle'] == 'PAUSED', keep=ping)
            assert call('/api/v1/playback/pause', {})['changed'] is True
            call('/api/v1/system/observer', {'waiting': False})
            time.sleep(0.3)
            assert status()['lifecycle'] == 'PAUSED'
            call('/api/v1/playback/play', {})
            until(lambda s: s['lifecycle'] == 'RUNNING')
            print('Observer hold: headless runs, an observer holds and releases, leaving releases, a pause stays a pause')
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    main()
