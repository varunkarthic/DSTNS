#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic
"""Derive container identity from the canonical engine version and Git revision."""
import datetime
import os
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = re.search(r'project\(dstns VERSION (\d+\.\d+\.\d+)', (root / 'CMakeLists.txt').read_text())[1]
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
ref = os.environ.get('GITHUB_REF', '')
if ref.startswith('refs/tags/') and ref != f'refs/tags/v{version}':
    raise SystemExit(f'Release tag must be v{version}, matching CMakeLists.txt')
# Only main and exact version tags can advance the public stable channel.
channel = 'stable' if ref == 'refs/heads/main' or ref == f'refs/tags/v{version}' else 'edge'
created = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
values = dict(version=version, revision=revision, created=created, channel=channel)
text = ''.join(f'{key}={value}\n' for key, value in values.items())
if os.environ.get('GITHUB_OUTPUT'):
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(text)
print(text, end='')
