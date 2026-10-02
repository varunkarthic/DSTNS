#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic
"""Verify a candidate manifest contains both CPUs before promoting public aliases."""
import argparse
import json
import os
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--digests', type=Path, required=True)
args = parser.parse_args()
image = os.environ['IMAGE']
meta = json.loads(os.environ['META'])
digests = sorted(p.name for p in args.digests.iterdir())
if len(digests) != 2 or any(not re.fullmatch('[0-9a-f]{64}', value) for value in digests):
    raise SystemExit('Expected exactly two verified platform digests')
candidate = f"{image}:candidate-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
annotations = [arg for value in meta.get('annotations', []) for arg in ('--annotation', value)]
subprocess.run(['docker', 'buildx', 'imagetools', 'create', *annotations, '-t', candidate,
                *(f'{image}@sha256:{value}' for value in digests)], check=True)
raw = subprocess.check_output(['docker', 'buildx', 'imagetools', 'inspect', '--raw', candidate], text=True)
manifest = json.loads(raw)
platforms = {(m['platform']['os'], m['platform']['architecture']) for m in manifest['manifests']}
if not {('linux', 'amd64'), ('linux', 'arm64')} <= platforms:
    raise SystemExit(f'Missing required platforms: {platforms}')
# Resolve once and promote that immutable index, including attestations.
info = subprocess.check_output(['docker', 'buildx', 'imagetools', 'inspect', candidate,
                                '--format', '{{json .Manifest}}'], text=True)
digest = json.loads(info)['digest']
subprocess.run(['docker', 'buildx', 'imagetools', 'create',
                *(arg for tag in meta['tags'] for arg in ('-t', tag)), f'{image}@{digest}'], check=True)
# Read back every alias to catch registry/tagging regressions.
for tag in meta['tags']:
    output = subprocess.check_output(['docker', 'buildx', 'imagetools', 'inspect', tag,
                                      '--format', '{{json .Manifest}}'], text=True)
    if json.loads(output)['digest'] != digest:
        raise SystemExit(f'{tag} does not point to tested index {digest}')
print(f'Published {image}@{digest} for linux/amd64 and linux/arm64')
with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
    summary.write(f'Published `{image}@{digest}` after native AMD64/ARM64 smoke tests and CI.\n\n')
    summary.write('\n'.join(f'- `{tag}`' for tag in meta['tags']) + '\n')
