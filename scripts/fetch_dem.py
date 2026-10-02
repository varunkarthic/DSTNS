#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Download terrain tiles (Terrarium PNG) into the DEM cache. Existing tiles are never re-fetched.

    fetch_dem.py --zoom 14 --tiles x0,y0,x1,y1 --cache data/dem

Tiles come from the AWS Open Data "Terrain Tiles" dataset (Mapzen/Tilezen,
Terrarium encoding: elevation = R*256 + G + B/256 - 32768 metres). Each tile is
validated (PNG signature, size) and written atomically, so an interrupted run
leaves no truncated tile. The engine decodes and resamples them; this script
only moves bytes. A manifest beside the tiles records where and when each came
from, for the run's provenance.

Licence: the tiles are free to use with attribution to Mapzen and to the
underlying sources (SRTM, GMTED2010, ETOPO1, 3DEP and others); see
https://github.com/tilezen/joerd/blob/master/docs/attribution.md
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_ENDPOINT = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
MIN_BYTES = 100
MAX_BYTES = 4 * 1024 * 1024
MAX_TILES = 64

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--zoom', type=int, required=True)
parser.add_argument('--tiles', required=True, help='x0,y0,x1,y1 inclusive tile range')
parser.add_argument('--cache', type=Path, default=Path('data/dem'))
parser.add_argument('--endpoint', default=os.environ.get('DSTNS_DEM_ENDPOINT', DEFAULT_ENDPOINT),
                    help='URL template with {z}, {x} and {y} (default: the AWS Terrain Tiles bucket)')
parser.add_argument('--timeout', type=float, default=30.0)
parser.add_argument('--retries', type=int, default=2)
args = parser.parse_args()


def fail(message):
    print(f'fetch_dem: {message}', file=sys.stderr)
    raise SystemExit(1)


try:
    x0, y0, x1, y1 = (int(v) for v in args.tiles.split(','))
except ValueError:
    fail('--tiles must be four integers: x0,y0,x1,y1')
if not 0 <= args.zoom <= 15:
    fail('--zoom must be in [0, 15]')
limit = 1 << args.zoom
if not (0 <= x0 <= x1 < limit and 0 <= y0 <= y1 < limit):
    fail(f'tile range {args.tiles} is outside zoom {args.zoom}')
if (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES:
    fail(f'more than {MAX_TILES} tiles requested; lower the zoom or the area')


def fetch(url):
    last = None
    for attempt in range(args.retries + 1):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'DSTNS terrain fetcher (+https://github.com/varunkarthic/DSTNS)'})
            with urllib.request.urlopen(request, timeout=args.timeout) as response:
                body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError('tile larger than the size limit')
            if len(body) < MIN_BYTES or not body.startswith(PNG_SIGNATURE):
                raise ValueError('response is not a PNG tile')
            return body
        except (urllib.error.URLError, OSError, ValueError) as error:
            last = error
            if isinstance(error, urllib.error.HTTPError) and error.code in (403, 404):
                break
            time.sleep(0.5 * (attempt + 1))
    fail(f'{url}: {last}')


directory = args.cache / 'terrarium' / str(args.zoom)
fetched = []
for x in range(x0, x1 + 1):
    for y in range(y0, y1 + 1):
        target = directory / str(x) / f'{y}.png'
        if target.is_file() and target.stat().st_size >= MIN_BYTES:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        url = args.endpoint.format(z=args.zoom, x=x, y=y)
        body = fetch(url)
        temporary = target.with_name(target.name + '.part')
        temporary.write_bytes(body)
        os.replace(temporary, target)
        fetched.append({'z': args.zoom, 'x': x, 'y': y, 'url': url, 'bytes': len(body),
                        'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds')})

manifest_path = args.cache / 'terrarium' / 'manifest.json'
try:
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
except (OSError, ValueError):
    manifest = {}
manifest.setdefault('provider', 'AWS Open Data Terrain Tiles')
manifest.setdefault('dataset', 'Mapzen/Tilezen Terrarium')
manifest.setdefault('licence', 'Attribution required: Mapzen, and SRTM, GMTED2010, ETOPO1, 3DEP and others; '
                                'see https://github.com/tilezen/joerd/blob/master/docs/attribution.md')
tiles = manifest.setdefault('tiles', {})
for entry in fetched:
    tiles[f"{entry['z']}/{entry['x']}/{entry['y']}"] = entry
temporary = manifest_path.with_name('manifest.json.part')
temporary.write_text(json.dumps(manifest, indent=1, sort_keys=True))
os.replace(temporary, manifest_path)
print(json.dumps({'fetched': len(fetched), 'zoom': args.zoom, 'tiles': args.tiles}))
