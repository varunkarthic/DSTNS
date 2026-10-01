# Troubleshooting

Symptoms first, then what causes them and what to do. For log locations see
[Logging](deployment/logging.md); `./launcher logs` reads them all.


## Quick diagnosis

```mermaid
flowchart TD
    A["Something is wrong"] --> B{"curl localhost:8090/health<br/>answers?"}
    B -->|no| C["The server is not running:<br/>see 'The server will not start'"]
    B -->|yes| D{"lifecycle?"}
    D -->|IDLE| E["No run, or the last start failed:<br/>check preparation_error in /playback/status"]
    D -->|PREPARING| F["Still building or downloading:<br/>check /system/map-status"]
    D -->|"RUNNING / PAUSED"| G{"Observer looks wrong?"}
    G -->|"DEGRADED, locked speed"| H["Backpressure: see below"]
    G -->|"blank or error banner"| I["Browser console, then<br/>'The observer shows an error'"]
    E --> J["MAP_FETCH_FAILED?<br/>see below"]
```

```bash
curl -s localhost:8090/health
curl -s localhost:8090/api/v1/playback/status | python3 -c 'import json,sys;d=json.load(sys.stdin)["data"];print(d["lifecycle"], d["preparation_error"])'
grep -E "ERROR|WARN" logs/system.log | tail
```

## The server will not start

Run it in the foreground to see why:

```bash
./build/dstns_server --port 8090 --logs logs
```

| Output | Fix |
|---|---|
| `DSTNS fatal: --port must be in [1, 65535]` | Use a real port |
| `DSTNS fatal: unknown argument: …` | See `dstns_server --help` |
| `cannot write operator credential` | `logs/` is not writable |
| `cannot open runtime log database` | `logs/runtime.db` is locked or the directory is read-only; `./launcher reset` |
| `API server failed to listen on …` | The port is taken; see below |

## Port 8090 or 8443 already in use

The CLI already moves to the next free port when 8090 is held by something
other than a current DSTNS server, and prints the port it chose. To free it:

```bash
lsof -i :8090
curl -X POST http://127.0.0.1:8090/api/v1/system/terminate   # a DSTNS server
kill <PID>                                                    # anything else
```

## Health check timeout during start-up

`Server did not become healthy within 15s`: the process started but never
answered `/health`. The CLI prints the tail of the server's output. Usually
`logs/` is not writable, or a stale build is running; `./launcher reset`, then
start again (the CLI rebuilds when sources change).

## MAP_FETCH_FAILED

The seed's city extract could not be downloaded, and DSTNS never substitutes
another city. The message names the city, the coordinates and the cause, and
the CLI lists maps already on disk.

- Check the network, VPN or proxy.
- Overpass mirrors rate-limit heavy users. Wait, or point at another instance:
  `DSTNS_OVERPASS_ENDPOINTS=https://overpass.example/api/interpreter ./launcher`.
- `implausibly small map` means the mirror returned an error page: the same
  rate limiting.
- Run offline from a cached extract:
  `./launcher start --osm-file data/maps/<city>_x5000.osm.xml`.

## Start-up stuck in PREPARING

Large extracts take 20 to 50 seconds to download the first time.
`curl -s localhost:8090/api/v1/system/map-status` shows the phase and bytes;
`preparation` says whether the core is `selecting`, `acquiring` or `building`.
Terminating at any point kills the download cleanly.

## CLI_START_REQUIRED

Runs are started by the CLI, which sends the credential in
`logs/operator.token`. A script that starts runs itself must send
`X-DSTNS-Operator: $(cat logs/operator.token)`, using the same `--logs`
directory the server was started with.

## CROSS_ORIGIN_FORBIDDEN

A browser page on one origin tried to change state on a server at another. If
that page is yours (the observer served from elsewhere, or a dashboard of your
own), add its origin: `DSTNS_ALLOWED_ORIGINS=https://ops.example.org`. Behind a
reverse proxy, forward the client's `Host` or set `X-Forwarded-Host`. See
[Security](deployment/security.md#origin-check-cross-site-request-forgery).

## SUMO reported unavailable

`/api/v1/system/info` reports `sumo.available: false` unless both `sumo` and
`netconvert` *start* and answer `--version`. Run them yourself:

```bash
$SUMO_HOME/bin/netconvert --version
$SUMO_HOME/bin/sumo --version
```

A `dyld: Library not loaded` (macOS) or `error while loading shared libraries`
(Linux) means the SUMO build links a library that has since changed. On macOS
with Homebrew this happens when an upgrade replaces `abseil` or `re2` under a
locally built SUMO. Rebuild SUMO against the current libraries, or reinstall
it (`brew reinstall sumo`). Set `SUMO_HOME` if SUMO is installed outside the
standard prefixes.

## The observer says it is behind, or locks speed

That is Adaptive Simulation Backpressure: the browser cannot keep up with the
simulation rate. It first lowers the rate ceiling, then turns layers and motion
off, then suspends the interface. It recovers on its own once the browser
catches up. Close other heavy tabs, choose a lower speed, or turn off layers.
See [ASB](concepts/backpressure.md).

## The interface says the window is too small

The observer needs at least 1024 × 640 CSS pixels and says so rather than
squeezing. Enlarge the window or zoom out.

## playback.tick_rate must be in (0, 5]

`config/defaults.json` or `--speed` asks for more than the engine allows.
Speeds offered in the interface are 0.25, 0.5, 1, 2, 3 and 5.

## Self-signed certificate warnings

The development gateway generates a self-signed certificate. Accept it in the
browser for local use, or mount trusted certificates into
`docker/certificates/`.

## Tests fail after pulling

Reconfigure from scratch: CMake fetches pinned versions of nlohmann/json and
cpp-httplib, and a stale cache can mix versions.

```bash
rm -rf build && cmake -S . -B build -DDSTNS_BUILD_TESTS=ON && cmake --build build -j
npm ci --prefix ui-engine
```

If only `api_smoke.py` fails at its SUMO step, see [SUMO reported
unavailable](#sumo-reported-unavailable).

## Southern-hemisphere cities fail to download

Versions before October 2026 could not download any city south of the equator
(Sydney, São Paulo, Johannesburg, Dar es Salaam…) on Python before 3.13:
`argument --bbox: expected one argument`. Update DSTNS. If you call
`scripts/fetch_osm.py` yourself, write `--bbox=S,W,N,E` with an equals sign.

## The observer shows an error

| Message | Meaning |
|---|---|
| "Simulator unavailable. Waiting to reconnect…" | The server stopped or the network dropped; the observer retries every second |
| "Synchronizing a new simulation…" | The run changed between two requests; resolves itself |
| "Map data is missing or incomplete." | The topology came back empty; check `preparation_error` |
| "Request failed (502)" or another status | Something in front of the server (a proxy or gateway) answered; check it |
| A dialog appears and vanishes | Fixed in October 2026; update |

Open the browser's developer console for the failing request.

## Docker

| Symptom | Fix |
|---|---|
| `port is already allocated` | `DSTNS_HOST_PORT=9090 docker compose up` |
| `[dstns-run] preparation failed: … no route to Overpass` | The container has no outbound HTTPS; set `HTTPS_PROXY`, or `DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml` |
| `Permission denied` on `/app/data/maps` | A bind-mounted directory must be writable by UID 10001 |
| The container restarts in a loop | `docker compose logs dstns` shows the server's last line |
| The build fails at `npm ci` or `cmake` | Network during the build; retry or pass `--build-arg HTTPS_PROXY=…` |

More in [Docker deployment: troubleshooting](deployment/docker.md#troubleshooting).

## A build fails after a system update

```text
make[3]: *** No rule to make target `/opt/homebrew/Cellar/openssl@3/3.6.3/lib/libssl.dylib'
```

A library the build was configured against was replaced. Reconfigure:

```bash
cmake --fresh -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j
```

!!! warning "Don't filter build output"
    `cmake --build build | grep error:` hides `make: *** … Error 2`, and a failed
    link leaves the previous executable in place, so you test old code without
    knowing. Check the exit status.

## A saved seed is refused

`unsupported map selection version` means it was saved under a different
seed-to-place algorithm; re-save it. `invalid saved seed ID` means the ID has
characters other than letters, digits, `_` and `-`, or is longer than 64.

## The documentation does not build

```bash
.venv-docs/bin/mkdocs build --strict
```

| Warning | Fix |
|---|---|
| `… not included in the "nav" configuration` | Add the page to `nav:` in `mkdocs.yml` |
| `contains a link '…', but the target is not found` | Fix the relative path; on macOS a case-only rename may not have reached the disk (`mv FILE tmp && mv tmp file`) |
| `contains a link '…#anchor', but … no such anchor` | Headings become anchors in lowercase with hyphens |

See [Writing documentation](development/documentation.md).

## Still stuck

Open an [issue](https://github.com/varunkarthic/DSTNS/issues) with the seed,
what you did, `logs/system.log`, and the output of
`curl -s localhost:8090/api/v1/system/info`.
