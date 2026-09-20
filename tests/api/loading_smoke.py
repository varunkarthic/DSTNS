#!/usr/bin/env python3
"""Slow real-map startup and regeneration under concurrent HTTP polling.

Uses an isolated server/cache and a gated OSM file, never a public endpoint.
Exercises the real HTTP thread pool and engine, including reset during I/O.
"""
import concurrent.futures as futures
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]

def main():
    with tempfile.TemporaryDirectory(prefix='dstns-loading-http-') as tmp:
        tmp = Path(tmp)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        server = subprocess.Popen([str(ROOT/'build/dstns_server'), '--host', '127.0.0.1', '--port', str(port), '--logs', str(tmp), '--map-cache', 'keep'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        token = ''
        def call(route, data=None, timeout=2):
            req = urllib.request.Request(f'http://127.0.0.1:{port}'+route, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json', 'X-DSTNS-Operator':token})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r: return r.status,json.load(r)
            except urllib.error.HTTPError as e: return e.code,json.load(e)
        def until(fn):
            end=time.monotonic()+8
            while time.monotonic()<end:
                try:
                    result=fn()
                    if result:return result
                except (OSError,ValueError):pass
                time.sleep(.02)
            raise AssertionError('Timed out waiting for server state')
        path=tmp/'delayed.osm.xml'
        xml=(ROOT/'tests/fixtures/roads.osm.xml').read_bytes()
        fd=None
        try:
            until(lambda:call('/health')[0]==200)
            token=(tmp/'operator.token').read_text().strip()
            os.mkfifo(path);fd=os.open(path,os.O_RDWR)
            payload={'seed':'12345','playback_duration_seconds':3600,'map':{'osm_file':str(path)}}
            with futures.ThreadPoolExecutor(max_workers=32) as pool:
                start=pool.submit(call,'/api/v1/playback/start',payload,10)
                until(lambda:call('/api/v1/system/map-status')[1]['data']['preparation']=='building')
                routes=['/api/v1/playback/status','/api/v1/view/snapshot','/api/v1/view/topology','/api/v1/system/map-status','/health']*6
                readers=[pool.submit(call,r) for r in routes]
                try:
                    results=[r.result(timeout=3) for r in readers]
                    assert all(r[0]==200 for r in results),results
                    assert call('/api/v1/playback/status')[1]['data']['lifecycle']=='PREPARING'
                    assert call('/api/v1/playback/start',payload)[0]==409
                finally:
                    os.write(fd,xml);os.close(fd);fd=None
                assert start.result()[0]==202
            until(lambda: call('/api/v1/playback/status')[1]['data']['lifecycle']=='RUNNING')
            old=call('/api/v1/playback/status')[1]['run_id']
            path.unlink();path.write_bytes(xml)
            assert call('/api/v1/world/regenerate',{})[0]==202
            ready=until(lambda: (s if (s:=call('/api/v1/world/status')[1]['data'])['state']=='ready' else None))
            assert ready['run_id']!=old
            assert call('/api/v1/playback/status')[1]['data']['lifecycle']=='PAUSED'
            # Gate a replacement; reset must cancel its eventual installation.
            path.unlink();os.mkfifo(path);fd=os.open(path,os.O_RDWR)
            assert call('/api/v1/world/regenerate',{})[0]==202
            until(lambda:call('/api/v1/system/map-status')[1]['data']['preparation']=='building')
            assert call('/api/v1/playback/reset',{})[0]==200
            os.write(fd,xml);os.close(fd);fd=None
            failed=until(lambda: (s if (s:=call('/api/v1/world/status')[1]['data'])['state']=='failed' else None))
            assert failed['error']['code']=='WORLD_CANCELLED'
            assert call('/api/v1/playback/status')[1]['data']['lifecycle']=='IDLE'
            # Missing maps give a persistent error to a browser opened earlier.
            path.unlink()
            assert call('/api/v1/playback/start',payload)[0]==202
            failed=until(lambda: (s if (s:=call('/api/v1/playback/status')[1]['data'])['lifecycle']=='IDLE' and s['preparation_error'] else None))
            assert 'cannot open OSM' in failed['preparation_error']
            path.write_bytes(xml)
            assert call('/api/v1/playback/start',payload)[0]==202
            assert call('/api/v1/playback/status')[1]['data']['preparation_error']==''
            print('Loading HTTP: 30 concurrent reads, startup, conflict, regeneration, cancellation, failure and retry passed')
        finally:
            if fd is not None:
                os.write(fd,xml);os.close(fd)
            server.terminate()
            try:server.wait(timeout=10)
            except subprocess.TimeoutExpired:server.kill();server.wait()

if __name__=='__main__':main()
