#!/usr/bin/env python3
"""Download a real urban OSM tile from Overpass. Existing files are never overwritten.

Two ways to name the area:

    --bbox south,west,north,east          explicit box
    --anchor lat,lon --radius-m 2500      box centred on a point

The simulator calls this with --bbox, using coordinates its seed derived, and
treats a non-zero exit as a hard map-generation failure. Downloads are written
atomically so an interrupted run cannot leave a truncated map behind.
"""
import argparse
import hashlib
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ENDPOINT = 'https://overpass-api.de/api/interpreter'
MAX_BYTES = 200 * 1024 * 1024
MAX_AREA_SQ_DEG = 0.05
METRES_PER_DEGREE_LAT = 111320.0

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--bbox', help='south,west,north,east')
parser.add_argument('--anchor', help='lat,lon centre point; use with --radius-m')
parser.add_argument('--radius-m', type=float, default=2500.0, help='half-extent around --anchor (default: 2500)')
parser.add_argument('--output', type=Path, default=Path('data/maps/berlin-urban.osm.xml'))
parser.add_argument('--retries', type=int, default=2, help='extra attempts after a transient failure')
parser.add_argument('--timeout', type=int, default=180)
args = parser.parse_args()


def fail(message):
    """Exit non-zero with a single-line reason the C++ caller can surface verbatim."""
    print(f'fetch_osm: {message}', file=sys.stderr)
    raise SystemExit(1)


def parse_coords():
    if args.bbox and args.anchor:
        fail('provide either --bbox or --anchor, not both')
    if args.bbox:
        try:
            values = [float(v) for v in args.bbox.split(',')]
        except ValueError:
            fail('--bbox must be four comma-separated numbers: south,west,north,east')
        if len(values) != 4:
            fail('--bbox must be four comma-separated numbers: south,west,north,east')
        return values
    if not args.anchor:
        fail('provide --bbox or --anchor')
    try:
        lat, lon = (float(v) for v in args.anchor.split(','))
    except ValueError:
        fail('--anchor must be "lat,lon"')
    if not args.radius_m > 0:
        fail('--radius-m must be positive')
    d_lat = args.radius_m / METRES_PER_DEGREE_LAT
    d_lon = args.radius_m / (METRES_PER_DEGREE_LAT * max(0.01, math.cos(math.radians(lat))))
    return [lat - d_lat, lon - d_lon, lat + d_lat, lon + d_lon]


south, west, north, east = parse_coords()
if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
    fail(f'bbox out of range or inverted: {south},{west},{north},{east}')
area = (north - south) * (east - west)
if area > MAX_AREA_SQ_DEG:
    fail(f'requested area {area:.4f} sq deg exceeds the {MAX_AREA_SQ_DEG} sq deg limit; reduce --radius-m')
if args.output.exists():
    fail(f'{args.output} already exists; delete it or choose another path to preserve reproducibility')

box = f'{south},{west},{north},{east}'
query = (
    f'[out:xml][timeout:{args.timeout}];('
    + ''.join(f'way["{key}"]({box});' for key in ('highway', 'building', 'landuse', 'leisure'))
    + ''.join(f'nwr["{key}"]({box});' for key in ('amenity', 'shop', 'office'))
    + f'node["highway"="traffic_signals"]({box});'
    + ');(._;>;);out body;'
)
request = urllib.request.Request(
    ENDPOINT,
    data=urllib.parse.urlencode({'data': query}).encode(),
    headers={'User-Agent': 'DSTNS urban source importer'},
)

content = None
last_error = ''
for attempt in range(args.retries + 1):
    try:
        with urllib.request.urlopen(request, timeout=args.timeout + 40) as response:
            content = response.read(MAX_BYTES + 1)
        break
    except urllib.error.HTTPError as error:
        # 429 (too many requests) and 504 (gateway timeout) are Overpass load shedding.
        last_error = f'Overpass returned HTTP {error.code} {error.reason}'
        retryable = error.code in (429, 502, 503, 504)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        last_error = f'network error contacting Overpass: {error}'
        retryable = True
    if not retryable or attempt == args.retries:
        fail(last_error)
    time.sleep(2 ** attempt * 5)

if content is None:
    fail(last_error or 'no response from Overpass')
if len(content) > MAX_BYTES:
    fail(f'OSM response exceeds {MAX_BYTES // (1024 * 1024)} MiB; reduce --radius-m')

try:
    root = ET.fromstring(content)
except ET.ParseError as error:
    fail(f'Overpass returned unparseable XML: {error}')
if root.tag != 'osm':
    fail(f'expected an <osm> document, got <{root.tag}>')
remark = root.find('remark')
if remark is not None:
    fail(f'Overpass reported an error: {(remark.text or "unspecified").strip()}')
if root.find('way') is None:
    fail(f'no roads found in {box}; the tile is empty water or wilderness')

args.output.parent.mkdir(parents=True, exist_ok=True)
# Write via a temporary sibling then rename, so readers never observe a partial file.
temporary = args.output.with_name(args.output.name + f'.{os.getpid()}.part')
try:
    temporary.write_bytes(content)
    os.replace(temporary, args.output)
except OSError as error:
    temporary.unlink(missing_ok=True)
    fail(f'could not write {args.output}: {error}')

manifest = {
    'source': 'OpenStreetMap contributors',
    'license': 'ODbL 1.0',
    'url': 'https://www.openstreetmap.org/copyright',
    'endpoint': ENDPOINT,
    'bbox': [south, west, north, east],
    'retrieved_at': datetime.now(timezone.utc).isoformat(),
    'sha256': hashlib.sha256(content).hexdigest(),
    'bytes': len(content),
    'query': query,
}
args.output.with_suffix('.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
