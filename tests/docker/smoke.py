#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic
"""Exercise a real packaged image without depending on external map services."""
import argparse
import json
import re
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image')
    parser.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
    parser.add_argument('--revision')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    version = re.search(r'project\(dstns VERSION (\d+\.\d+\.\d+)', (root / 'CMakeLists.txt').read_text())[1]
    observer = json.loads((root / 'ui-engine/package.json').read_text())['version']
    info = json.loads(docker('image', 'inspect', args.image))[0]
    assert info['Architecture'] == args.arch, info['Architecture']
    labels = info['Config']['Labels']
    assert labels['org.opencontainers.image.version'] == version
    assert labels['org.opencontainers.image.authors'].startswith('Varun Karthic')
    assert labels['org.opencontainers.image.licenses'] == 'AGPL-3.0-or-later'
    assert info['Config']['User'] == 'dstns'
    if args.revision:
        assert labels['org.opencontainers.image.revision'] == args.revision
    name = 'dstns-smoke-' + uuid.uuid4().hex[:10]
    try:
        docker('run', '-d', '--name', name, '-p', '127.0.0.1::8090',
               '-e', 'DSTNS_SEED=382923', '-e', 'DSTNS_DISABLE_WORLD_REGENERATION=1',
               '-e', 'DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml', args.image)
        port = docker('port', name, '8090/tcp').rsplit(':', 1)[1]
        base = 'http://127.0.0.1:' + port

        def get(path):
            with urllib.request.urlopen(base + path, timeout=5) as response:
                return json.load(response)

        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                status = get('/api/v1/playback/status')['data']
                health = docker('inspect', '--format', '{{.State.Health.Status}}', name)
                if status['lifecycle'] == 'RUNNING' and health == 'healthy':
                    break
            except (OSError, ValueError):
                pass
            time.sleep(1)
        else:
            raise AssertionError('Container never became healthy with a RUNNING simulation')
        assert get('/health')['version'] == version
        runtime = get('/api/v1/system/info')
        assert runtime['version'] == version
        assert runtime['build']['revision'] == labels['org.opencontainers.image.revision']
        assert runtime['build']['channel'] == labels['io.dstns.channel']
        assert runtime['build']['created'] == labels['org.opencontainers.image.created']
        assert runtime['build']['type'] == 'Release'
        packaged = json.loads(docker('exec', name, 'cat', '/app/build-info.json'))
        assert packaged['version'] == version and packaged['observer_version'] == observer
        assert packaged['revision'] == runtime['build']['revision']
        assert packaged['platform'] == 'linux/' + args.arch
        cli = docker('exec', name, '/app/build/dstns_server', '--version')
        assert f'DSTNS {version}' in cli and packaged['revision'] in cli
        assert docker('exec', name, 'id', '-u') == '10001'
        for path in ('/app/LICENSE', '/app/COPYRIGHT'):
            docker('exec', name, 'test', '-s', path)
        topology = get('/api/v1/view/topology')['data']
        assert len(topology['nodes']) > 100 and len(topology['edges']) > 100
        with urllib.request.urlopen(base + '/', timeout=5) as response:
            html = response.read().decode()
        assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
        assert assets, 'Observer bundle missing from served HTML'
        for asset in assets:
            with urllib.request.urlopen(base + asset, timeout=5) as response:
                assert response.status == 200 and len(response.read()) > 0
        # Exercise replacement through the shipped operator helper.
        docker('exec', name, 'dstns-run', '--seed', '42')
        replaced = get('/api/v1/playback/status')['data']
        assert replaced['lifecycle'] == 'RUNNING' and str(replaced['seed']) == '42'
        assert replaced['run_id'] != status['run_id']
        docker('stop', '--time', '20', name)
        state = json.loads(docker('inspect', name))[0]['State']
        assert not state['OOMKilled'] and state['ExitCode'] != 137, state
        print(f'PASS {args.arch}: health, running map, observer assets, provenance, non-root, run replacement, shutdown')
    except BaseException:
        subprocess.run(['docker', 'logs', '--tail', '60', name], check=False)
        raise
    finally:
        subprocess.run(['docker', 'rm', '-fv', name], check=False, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
