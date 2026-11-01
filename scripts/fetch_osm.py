#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

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
import http.client
import json
import math
import os
import socket
import sys
import time
import zlib
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
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
)
# A mirror that will not even accept a connection is not worth a full wait for data.
CONNECT_SECONDS = 10
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
parser.add_argument('--timeout', type=int, default=90, help='seconds Overpass may spend on the query')
parser.add_argument('--quiet-seconds', type=float, default=60,
                    help='move to the next mirror after this long with no data from this one')
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

args.output.parent.mkdir(parents=True, exist_ok=True)

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


temporary = args.output.with_name(args.output.name + f'.{os.getpid()}.part')


class Unusable(Exception):
    """This mirror's answer cannot be used, though another's might be."""


def read_streaming(response):
    """Write the response to the temporary file as it arrives; return its digest and size."""
    # Overpass sends Content-Length only sometimes; report what is known.
    total = int(response.headers.get('Content-Length') or 0)
    gzipped = response.headers.get('Content-Encoding') == 'gzip'
    inflate = zlib.decompressobj(31) if gzipped else None
    digest, size, received, last = hashlib.sha256(), 0, 0, 0.0
    with temporary.open('wb') as out:
        while True:
            # read1 returns what has arrived rather than waiting to fill the buffer.
            chunk = response.read1(256 * 1024)
            if not chunk:
                break
            received += len(chunk)
            data = inflate.decompress(chunk) if inflate else chunk
            size += len(data)
            if size > MAX_BYTES:
                raise ValueError('too large')
            digest.update(data)
            out.write(data)
            now = time.monotonic()
            if now - last > 0.25:
                publish('download', received, total)
                last = now
    publish('download', received, total or received)
    return digest.hexdigest(), size


def check_map():
    """Read the document as a stream, so a large map need not all be in memory."""
    roads, root = False, None
    try:
        for event, element in ET.iterparse(temporary, events=('start', 'end')):
            if root is None:
                root = element
                if root.tag != 'osm':
                    raise Unusable(f'expected an <osm> document, got <{root.tag}>')
            if event == 'end':
                if element.tag == 'remark':
                    raise Unusable(f'Overpass reported an error: {(element.text or "unspecified").strip()}')
                roads = roads or element.tag == 'way'
                root.clear()
    except ET.ParseError as error:
        raise Unusable(f'Overpass returned unparseable XML: {error}') from error
    return roads


digest = None
used_endpoint = ''
publish('connect')
# Per-endpoint outcome, so a failure can say what every mirror actually said
# rather than only the last one.
outcomes = {}
refused_everywhere = True
remaining = endpoints()
for attempt in range(args.retries + 1):
    # A busy mirror is left for the next one at once. Only when all have been
    # tried is it worth waiting to ask them again.
    if attempt:
        publish('retry')
        time.sleep(2 ** (attempt - 1) * 3)
    retry = []
    for endpoint in remaining:
        request = urllib.request.Request(
            endpoint,
            data=payload,
            headers={'User-Agent': 'DSTNS urban source importer', 'Accept-Encoding': 'gzip'},
        )
        reason = ''
        try:
            if not urllib.request.getproxies():
                parts = urllib.parse.urlsplit(endpoint)
                port = parts.port or (443 if parts.scheme == 'https' else 80)
                socket.create_connection((parts.hostname, port), CONNECT_SECONDS).close()
            with urllib.request.urlopen(request, timeout=args.quiet_seconds) as response:
                digest, size = read_streaming(response)
            publish('parse', size, size)
            if not check_map():
                temporary.unlink(missing_ok=True)
                fail(f'no roads found in {box}; the tile is empty water or wilderness')
            used_endpoint = endpoint
            break
        except ValueError:
            temporary.unlink(missing_ok=True)
            fail(f'OSM response exceeds {MAX_BYTES // (1024 * 1024)} MiB; reduce the extent')
        except Unusable as error:
            reason = str(error)
            refused_everywhere = False
            retry.append(endpoint)
        except urllib.error.HTTPError as error:
            # 429 and 5xx are Overpass shedding load; anything else is our request.
            reason = f'HTTP {error.code} {error.reason}'
            refused_everywhere = False
            if error.code in (429, 500, 502, 503, 504):
                retry.append(endpoint)
        except (urllib.error.URLError, http.client.HTTPException, zlib.error, TimeoutError, OSError) as error:
            inner = getattr(error, 'reason', error)
            reason = str(inner) or type(inner).__name__
            if not isinstance(inner, (ConnectionRefusedError, socket.gaierror)):
                refused_everywhere = False
            retry.append(endpoint)
        digest = None
        temporary.unlink(missing_ok=True)
        outcomes[endpoint] = f'{host_of(endpoint)} ({reason or "no response"})'
        publish('connect')
    if digest is not None or not retry:
        break
    remaining = retry

if digest is None:
    detail = '; '.join(outcomes.values()) or 'no endpoints configured'
    if refused_everywhere:
        fail('no route to Overpass from this host: ' + detail
             + '. Check the network connection, VPN or proxy, or set DSTNS_OVERPASS_ENDPOINTS '
               'to a reachable Overpass instance. An already cached city can be used with --osm-file.')
    fail('every Overpass endpoint failed: ' + detail)

# Renamed into place, so readers never observe a partial file.
try:
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
    'sha256': digest,
    'bytes': size,
    'query': query,
}
args.output.with_suffix('.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
progress_path.unlink(missing_ok=True)
print(json.dumps(manifest, indent=2))
