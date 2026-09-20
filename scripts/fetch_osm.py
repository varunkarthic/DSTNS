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
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

# Overpass mirrors, tried in order. One host refusing connections, rate
# limiting or timing out must not end a run, so the fetcher fails over rather
# than depending on a single volunteer-run server. Override with --endpoint
# (repeatable) or DSTNS_OVERPASS_ENDPOINTS to use a private instance.
DEFAULT_ENDPOINTS = (
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.osm.jp/api/interpreter',
)
MAX_BYTES = 200 * 1024 * 1024
MAX_AREA_SQ_DEG = 0.05
METRES_PER_DEGREE_LAT = 111320.0

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--bbox', help='south,west,north,east')
parser.add_argument('--anchor', help='lat,lon centre point; use with --radius-m')
parser.add_argument('--radius-m', type=float, default=2500.0, help='half-extent around --anchor (default: 2500)')
parser.add_argument('--output', type=Path, default=Path('data/maps/berlin-urban.osm.xml'))
parser.add_argument('--retries', type=int, default=1, help='extra attempts per endpoint after a transient failure')
parser.add_argument('--endpoint', action='append', default=[],
                    help='Overpass endpoint to use instead of the built-in mirrors; repeat for failover')
parser.add_argument('--timeout', type=int, default=180)
args = parser.parse_args()


def fail(message):
    """Exit non-zero with a single-line reason the C++ caller can surface verbatim."""
    try:
        (args.output.with_name(args.output.name + '.progress')).unlink(missing_ok=True)
    except (OSError, NameError):
        pass
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
payload = urllib.parse.urlencode({'data': query}).encode()


def endpoints():
    """Endpoints to try, in order: the flag, then the environment, then the mirrors."""
    chosen = list(args.endpoint)
    if not chosen:
        chosen = [e.strip() for e in os.environ.get('DSTNS_OVERPASS_ENDPOINTS', '').split(',') if e.strip()]
    return chosen or list(DEFAULT_ENDPOINTS)


def host_of(url):
    return urllib.parse.urlsplit(url).netloc or url

# Progress is published beside the target so the operator CLI can render a bar
# for what is otherwise a silent multi-minute wait inside the core.
progress_path = args.output.with_name(args.output.name + '.progress')


def publish(phase, done=0, total=0):
    try:
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = progress_path.with_suffix('.tmp')
        tmp.write_text(json.dumps({'phase': phase, 'bytes': done, 'total': total}))
        os.replace(tmp, progress_path)
    except OSError:
        pass  # Progress reporting must never break the download.


def read_streaming(response):
    # Overpass sends Content-Length only sometimes; report what is known.
    total = int(response.headers.get('Content-Length') or 0)
    chunks, done, last = [], 0, 0.0
    while True:
        chunk = response.read(256 * 1024)
        if not chunk:
            break
        chunks.append(chunk)
        done += len(chunk)
        if done > MAX_BYTES:
            raise ValueError('too large')
        now = time.monotonic()
        if now - last > 0.25:
            publish('download', done, total)
            last = now
    publish('download', done, total or done)
    return b''.join(chunks)


content = None
used_endpoint = ''
publish('connect')
# Per-endpoint outcome, so a failure can say what every mirror actually said
# rather than only the last one.
outcomes = []
refused_everywhere = True
for endpoint in endpoints():
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={'User-Agent': 'DSTNS urban source importer'},
    )
    reason = ''
    for attempt in range(args.retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=args.timeout + 40) as response:
                content = read_streaming(response)
            break
        except ValueError:
            progress_path.unlink(missing_ok=True)
            fail(f'OSM response exceeds {MAX_BYTES // (1024 * 1024)} MiB; reduce the extent')
        except urllib.error.HTTPError as error:
            # 429 and 5xx are Overpass shedding load; anything else is our request.
            reason = f'HTTP {error.code} {error.reason}'
            refused_everywhere = False
            if error.code not in (429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            inner = getattr(error, 'reason', error)
            reason = str(inner)
            if not isinstance(inner, (ConnectionRefusedError, socket.gaierror)):
                refused_everywhere = False
        if content is not None or attempt == args.retries:
            break
        publish('retry')
        time.sleep(2 ** attempt * 3)
    if content is not None:
        used_endpoint = endpoint
        break
    outcomes.append(f'{host_of(endpoint)} ({reason or "no response"})')
    publish('connect')

if content is None:
    detail = '; '.join(outcomes) or 'no endpoints configured'
    if refused_everywhere:
        fail('no route to Overpass from this host: ' + detail
             + '. Check the network connection, VPN or proxy, or set DSTNS_OVERPASS_ENDPOINTS '
               'to a reachable Overpass instance. An already cached city can be used with --osm-file.')
    fail('every Overpass endpoint failed: ' + detail)

if len(content) > MAX_BYTES:
    fail(f'OSM response exceeds {MAX_BYTES // (1024 * 1024)} MiB; reduce --radius-m')

publish('parse', len(content), len(content))
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
    'endpoint': used_endpoint,
    'bbox': [south, west, north, east],
    'retrieved_at': datetime.now(timezone.utc).isoformat(),
    'sha256': hashlib.sha256(content).hexdigest(),
    'bytes': len(content),
    'query': query,
}
args.output.with_suffix('.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
progress_path.unlink(missing_ok=True)
print(json.dumps(manifest, indent=2))
