#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic
"""Release boundary regressions; these never write to a registry."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class ReleaseTests(unittest.TestCase):
    def metadata(self, ref):
        env = {**os.environ, 'GITHUB_REF': ref}
        env.pop('GITHUB_OUTPUT', None)
        return subprocess.run([sys.executable, str(ROOT / 'scripts/image-metadata.py')],
                              env=env, text=True, capture_output=True)

    def test_main_and_release_are_stable(self):
        for ref in ('refs/heads/main', 'refs/tags/v2.1.0'):
            result = self.metadata(ref)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('channel=stable', result.stdout)
            self.assertIn('version=2.1.0', result.stdout)

    def test_other_branches_do_not_promote_stable(self):
        self.assertIn('channel=edge', self.metadata('refs/heads/experiment').stdout)

    def test_mismatched_release_tag_is_rejected(self):
        self.assertNotEqual(self.metadata('refs/tags/v9.9.9').returncode, 0)

    def publication(self, architectures, readback='sha256:' + 'c' * 64):
        calls = []
        digest = 'sha256:' + 'c' * 64
        def run(command, **kwargs):
            calls.append(command)
        def output(command, **kwargs):
            if '--raw' in command:
                return json.dumps({'manifests': [{'platform': {'os': 'linux', 'architecture': a}}
                                                for a in architectures]})
            return json.dumps({'digest': digest if ':candidate-' in command[4] else readback})
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'digests'
            directory.mkdir()
            for char in ('a', 'b'):
                (directory / (char * 64)).touch()
            env = dict(IMAGE='ghcr.io/example/test', META=json.dumps({'tags': ['ghcr.io/example/test:stable']}),
                       GITHUB_RUN_ID='1', GITHUB_RUN_ATTEMPT='1', GITHUB_STEP_SUMMARY=str(Path(tmp) / 'summary'))
            with patch.dict(os.environ, env), patch.object(sys, 'argv', ['publish-image.py', '--digests', str(directory)]), \
                 patch('subprocess.run', side_effect=run), patch('subprocess.check_output', side_effect=output), \
                 contextlib.redirect_stdout(io.StringIO()):
                try:
                    runpy.run_path(str(ROOT / 'scripts/publish-image.py'), run_name='__main__')
                except SystemExit as error:
                    return calls, error
        return calls, None

    def test_missing_arm64_never_promotes_stable(self):
        calls, error = self.publication(['amd64'])
        self.assertIsNotNone(error)
        self.assertEqual(len(calls), 1)  # candidate only
        self.assertNotIn('ghcr.io/example/test:stable', calls[0])

    def test_both_platforms_promote_immutable_digest(self):
        calls, error = self.publication(['amd64', 'arm64'])
        self.assertIsNone(error)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][-1], 'ghcr.io/example/test@sha256:' + 'c' * 64)

    def test_incorrect_tag_readback_fails(self):
        _, error = self.publication(['amd64', 'arm64'], 'sha256:' + 'd' * 64)
        self.assertIsNotNone(error)


if __name__ == '__main__':
    unittest.main()
