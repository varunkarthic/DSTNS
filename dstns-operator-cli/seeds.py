#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Transactional saved configurations. IDs are database keys, never paths."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from datetime import datetime, timezone

VERSION = 'urban-crfg-v3'
ROOT = Path(__file__).resolve().parent.parent

def seed_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', value):
        raise ValueError('Seed ID must be 1-64 letters, digits, underscores or hyphens')
    return value

def operate(action, data):
    db_path = Path(os.environ.get('DSTNS_SEED_DB', ROOT / 'data/seed-store/seeds.sqlite3'))
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path, timeout=10) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE IF NOT EXISTS seeds (id TEXT PRIMARY KEY, seed TEXT NOT NULL, created_at TEXT NOT NULL, description TEXT NOT NULL, map_version TEXT NOT NULL, map_sha256 TEXT NOT NULL, config_json TEXT NOT NULL)')
        db.execute('PRAGMA user_version=1')
        db.row_factory = sqlite3.Row
        if action == 'list':
            return [dict(row) for row in db.execute('SELECT id, seed, created_at, description, map_version FROM seeds ORDER BY id')]
        name = seed_id(data.get('id'))
        if action == 'save':
            cfg = data['config']
            if cfg.get('map_selection_version') != VERSION:
                raise ValueError('Unsupported map selection version')
            source = Path(cfg['map']['osm_file']).resolve(strict=True)
            content = source.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            maps = db_path.parent / 'maps'
            maps.mkdir(exist_ok=True)
            cached = maps / (digest + '.osm.xml')
            if not cached.exists():
                with cached.open('xb') as f:
                    f.write(content)
            cfg['map']['osm_file'] = str(cached.resolve())
            cfg['saved_seed_id'] = name
            try:
                db.execute('INSERT INTO seeds VALUES (?,?,?,?,?,?,?)', (name, cfg['seed'], datetime.now(timezone.utc).isoformat(), data.get('description', '')[:1000], VERSION, digest, json.dumps(cfg, sort_keys=True)))
            except sqlite3.IntegrityError as exc:
                raise ValueError(f'Saved seed already exists: {name}') from exc
        row = db.execute('SELECT * FROM seeds WHERE id=?', (name,)).fetchone()
        if row is None:
            raise ValueError(f'Unknown saved seed: {name}')
        result = dict(row)
        result['config'] = json.loads(result.pop('config_json'))
        if action == 'use':
            if result['map_version'] != VERSION:
                raise ValueError('Saved seed requires an unsupported map version')
            source = Path(result['config']['map']['osm_file'])
            if hashlib.sha256(source.read_bytes()).hexdigest() != result['map_sha256']:
                raise ValueError('Saved map content changed; refusing a non-reproducible run')
        if action == 'delete':
            db.execute('DELETE FROM seeds WHERE id=?', (name,))
            return {'deleted': name}
        if action not in ('save', 'use', 'inspect'):
            raise ValueError('Unknown saved-seed action')
        return result

if __name__ == '__main__':
    try:
        print(json.dumps(operate(sys.argv[1], json.load(sys.stdin))))
    except (ValueError, KeyError, OSError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
