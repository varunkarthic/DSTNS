#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Realistic News over HTTP, against a stand-in Chat Completions server.

The stand-in plays the part `fm serve` plays on a Mac: it receives the facts of
each narratable news item and answers with an item. Checks that the server
sends facts and context rather than internal identifiers, that narrations
reach a client that asks for them (?narration=realistic, directly and through
the since_narration cursor) and no other, that the narrator reports itself,
and that --narrator off leaves the feed exactly as it was.
"""
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SERVER = os.environ.get('DSTNS_SERVER', str(ROOT / 'build/dstns_server'))


class StandIn(http.server.BaseHTTPRequestHandler):
    facts = []

    def log_message(self, *args):
        pass

    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send({'object': 'list', 'data': [{'id': 'stand-in'}]})

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        facts = request['messages'][-1]['content']
        StandIn.facts.append(facts)
        cleared = 'cleared' in facts
        text = ('The incident has cleared and traffic is moving normally again.' if cleared
                else 'Drivers are reporting slow traffic in the area this hour.')
        self._send({'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text}}]})


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def run(tmp, narrator_args):
    port = free_port()
    logs = tmp / ('logs-' + str(port))
    server = subprocess.Popen([SERVER, '--host', '127.0.0.1', '--port', str(port), '--logs', str(logs), *narrator_args],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    token = ''

    def call(route, data=None):
        req = urllib.request.Request(f'http://127.0.0.1:{port}' + route, data=None if data is None else json.dumps(data).encode(),
                                     headers={'Content-Type': 'application/json', 'X-DSTNS-Operator': token})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def until(fn, seconds=20):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                result = fn()
                if result:
                    return result
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(0.05)
        raise AssertionError('Timed out waiting for server state')

    try:
        until(lambda: call('/health')[0] == 200)
        token = (logs / 'operator.token').read_text().strip()
        payload = {'seed': '4242', 'playback_duration_seconds': 3600, 'fixture': {'grid_width': 12, 'grid_height': 10},
                   'modules': {'buildings': False}}
        assert call('/api/v1/playback/prepare', payload)[0] in (200, 202)
        until(lambda: call('/api/v1/playback/status')[1]['data']['lifecycle'] == 'READY')
        # Step through the day so every incident fires and clears.
        for _ in range(24):
            assert call('/api/v1/playback/step', {'seconds': 3600})[0] == 200
        status, news = call('/api/v1/news?since_news_id=0&limit=500')
        assert status == 200
        return call, until, news['data']
    finally:
        run.cleanup.append(server)


run.cleanup = []


def main():
    stand_in = http.server.ThreadingHTTPServer(('127.0.0.1', 0), StandIn)
    threading.Thread(target=stand_in.serve_forever, daemon=True).start()
    endpoint = f'http://127.0.0.1:{stand_in.server_address[1]}'
    try:
        with tempfile.TemporaryDirectory(prefix='dstns-narration-http-') as tmp:
            tmp = Path(tmp)

            call, until, feed = run(tmp, ['--narrator', endpoint, '--narrator-cache', 'none'])
            incidents = [n for n in feed['items'] if n['template_id'].startswith('INCIDENT_')]
            assert incidents, 'the fixture day has incidents'
            # Narrations were prefetched at prepare; any written after an item was
            # served arrive through the cursor.
            def narrated():
                d = call('/api/v1/news?since_news_id=0&limit=500&narration=realistic')[1]['data']
                return d if all('narrative' in n for n in d['items'] if n['template_id'].startswith('INCIDENT_')) else None
            feed = until(narrated)
            assert 'narration_sequence' in feed and feed['narration_sequence'] >= 1
            cursor = call(f"/api/v1/news?since_news_id={feed['items'][-1]['news_id']}&since_narration=0&narration=realistic")[1]['data']
            assert any(n['narrative'] for n in cursor['narrated']), 'the cursor lists narrations of items already served'
            caught_up = call(f"/api/v1/news?since_news_id={feed['items'][-1]['news_id']}&since_narration={feed['narration_sequence']}&narration=realistic")[1]['data']
            assert caught_up['narrated'] == [], 'a client that is up to date is sent nothing again'
            assert StandIn.facts and all('Edge #' not in f and 'Event:' in f and 'Time:' in f for f in StandIn.facts), \
                'the model sees facts and context, not identifiers'
            plain_with_narrator = call('/api/v1/news?since_news_id=0&limit=500')[1]['data']
            assert all('narrative' not in n for n in plain_with_narrator['items']) and 'narrated' not in plain_with_narrator, \
                'narrations are served only to a client that asks for them'
            snapshot = call('/api/v1/view/snapshot')[1]['data']
            assert all('narrative' not in n for n in snapshot['event_stack']), 'nor are they in the snapshot'
            narrator = call('/api/v1/system/narrator')[1]['data']
            assert narrator['enabled'] and narrator['backend']['endpoint'] == endpoint and narrator['completed'] >= 1, narrator
            core_text = [(n['template_id'], n['message']) for n in feed['items']]

            call, until, plain = run(tmp, ['--narrator', 'off'])
            assert all('narrative' not in n for n in plain['items']), 'no narrator, no narratives'
            assert 'narration_sequence' not in plain and 'narrated' not in plain, 'the feed keeps its old shape'
            assert [(n['template_id'], n['message']) for n in plain['items']] == core_text, 'narration never changes the core text'
            assert call('/api/v1/system/narrator')[1]['data']['enabled'] is False
    finally:
        for server in run.cleanup:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
        stand_in.shutdown()
    print('narration smoke: ok')


if __name__ == '__main__':
    main()
