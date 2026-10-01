<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-light.svg">
  <img alt="DSTNS" src="docs/assets/wordmark-dark.svg" width="320">
</picture>

### Deterministic Spatiotemporal Transport Network Simulator

**A seed picks a real city district from OpenStreetMap and simulates a full day of
traffic on it — signals, demand, weather, flooding and incidents — on one
authoritative virtual clock. The same seed always gives the same world and the same day.**

[![CI](https://github.com/varunkarthic/DSTNS/actions/workflows/ci.yml/badge.svg)](https://github.com/varunkarthic/DSTNS/actions/workflows/ci.yml)
[![Documentation](https://readthedocs.org/projects/dstns/badge/?version=latest)](https://dstns.readthedocs.io/en/latest/)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![C++20](https://img.shields.io/badge/C%2B%2B-20-00599C?logo=cplusplus&logoColor=white)](https://en.cppreference.com/w/cpp/20)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Docker](https://img.shields.io/badge/Docker-amd64%20%7C%20arm64-2496ED?logo=docker&logoColor=white)](docs/getting-started/docker.md)
[![OpenStreetMap](https://img.shields.io/badge/maps-OpenStreetMap-7EBC6F?logo=openstreetmap&logoColor=white)](https://www.openstreetmap.org/copyright)
[![SUMO](https://img.shields.io/badge/SUMO-optional-orange)](docs/components/sumo-adapter.md)

[**Documentation**](https://dstns.readthedocs.io/) ·
[Quick start](#quick-start) ·
[Docker](#run-with-docker) ·
[From source](#run-from-source) ·
[API](docs/api/index.md) ·
[Troubleshooting](docs/troubleshooting.md)

<img src="docs/assets/screenshots/observer.png" alt="The DSTNS observer watching a district of Dar es Salaam" width="100%">

</div>

---

## Contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Run with Docker](#run-with-docker)
- [Run from source](#run-from-source)
- [Using the observer](#using-the-observer)
- [Using the API](#using-the-api)
- [Configuration](#configuration)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Documentation](#documentation)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Highlights

| | |
|---|---|
| 🌍 **Real places, chosen by a number** | A seed resolves to one of **181 cities** on every inhabited continent and a district inside it. The road network is downloaded from OpenStreetMap once and cached. |
| 🎲 **Deterministic to the bit** | SHA-256 sub-seeds per subsystem, counter-based random numbers, fixed one-second physics, checkpoint replay. Two engines with the same seed agree exactly. |
| 🚦 **A living network** | Signals snapped to real junctions and coordinated in green waves; place-driven weekday and weekend demand; storms with Wendland C² rain fields; flooding that closes roads; at least four incidents a day. |
| ⏪ **Time travel** | Pause, step, seek backwards and forwards through the day; undo and redo operator controls. |
| 🖥️ **An observer built for watching** | Live map, telemetry, notifications, Auto Focus, a guided tutorial and a PDF report, kept in step by adaptive backpressure. |
| 🔌 **A complete HTTP API** | Every view and control over JSON, a self-describing route index, and an [OpenAPI 3.1 description](docs/api/openapi.yaml). |
| 🐳 **Docker-ready** | A 234 MB multi-architecture image that starts a simulation with one command; optional TLS gateway and SUMO. |
| 🔬 **SUMO cross-check** | Export any world to Eclipse SUMO and run it microscopically as a batch job. |

> [!NOTE]
> The live model is **aggregate** — flows and queues per directed road segment,
> not individual vehicles — which is what makes a whole day of a 3,000-junction
> district cheap enough to scrub back and forth interactively.

## Quick start

**With Docker** (nothing else to install):

```bash
git clone https://github.com/varunkarthic/DSTNS.git && cd DSTNS
docker compose up --build
```

**From source** (macOS or Linux):

```bash
git clone https://github.com/varunkarthic/DSTNS.git && cd DSTNS
./launcher
```

Then open **<http://localhost:8090>**. The observer narrates the seed resolving
to a city, the map downloading (20–60 s the first time for a city) and the
world being built, then the day starts.

## How it works

```mermaid
flowchart LR
    Seed(["Seed<br/>382923"]) --> Place["City + district<br/>(181-city catalogue)"]
    Place --> OSM[("OpenStreetMap<br/>Overpass API")]
    OSM --> Graph["Road graph<br/>true metres, canonical IDs"]
    Seed --> Sched["Signals · demand ·<br/>weather · incidents"]
    Graph --> Engine["SimulationEngine<br/>1-second physics"]
    Sched --> Engine
    Engine --> API["HTTP API"]
    API --> Observer["Observer<br/>(browser)"]
    API --> You["Your scripts"]
    CLI["Operator CLI"] -- "start (credential)" --> API
```

| Part | What it is |
|---|---|
| **Core** (`dstns_server`) | C++20. Compiles a scenario from a seed, runs the virtual day, serves the API and the observer on one port. |
| **Operator CLI** (`./launcher`) | Node.js. Builds what changed, starts and supervises the server, starts runs, saved seeds, logs, tests. |
| **Observer** (`ui-engine/`) | React 19. Watches a run in the browser: map, telemetry, playback, reports. |

Read [Architecture](docs/concepts/architecture.md) for the full picture.

## Run with Docker

### Requirements

- Docker Engine 24+ or Docker Desktop, with Compose v2.
- About 1 GB free memory, 250 MB for the image, up to 50 MB per downloaded city.

### Start

```bash
docker compose up --build            # foreground; Ctrl-C to stop
docker compose up --build -d         # background
docker compose logs -f               # follow the log
```

The container starts the server, then a run, and the observer is at
**<http://localhost:8090>**.

```mermaid
sequenceDiagram
    participant You
    participant C as dstns container
    participant OSM as OpenStreetMap
    You->>C: docker compose up
    C->>C: server healthy
    C->>C: dstns-run starts a run from DSTNS_* settings
    C->>OSM: download the seed's city (first time only)
    C-->>You: http://localhost:8090 — the day is running
```

### Choose the run

```bash
DSTNS_SEED=382923 DSTNS_DAY_TYPE=weekend DSTNS_SPEED=2 docker compose up
```

or put the same settings in a `.env` file next to `docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `DSTNS_SEED` | `auto` | The seed; `auto` draws a fresh one |
| `DSTNS_DAY_TYPE` | `weekday` | `weekday` or `weekend` |
| `DSTNS_SPEED` | `1` | Speed, more than 0 and at most 5 |
| `DSTNS_DURATION` | `3600` | Wall-clock seconds per virtual day at 1× (60–3600) |
| `DSTNS_OSM_FILE` | `auto` | `auto` lets the seed choose a city; or a path in the container |
| `DSTNS_HOST_PORT` | `8090` | Port on your machine |
| `DSTNS_AUTOSTART` | `1` | `0` starts the server with no run |

All variables: [Docker deployment](docs/deployment/docker.md#environment-variables).

### Common tasks

```bash
docker compose exec dstns dstns-run --seed 42                     # start another run, no restart
docker compose exec dstns dstns-run --seed 42 --day-type weekend --speed 3
docker compose exec dstns dstns-run --status                      # what is running
DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml docker compose up   # offline, bundled map
docker compose --profile tls up --build                           # also HTTPS on :8443
DSTNS_WITH_SUMO=1 docker compose up --build                       # include Eclipse SUMO
docker compose down                                               # stop (keeps cached maps)
docker compose down --volumes                                     # stop and delete maps and logs
```

> [!TIP]
> No internet? The image includes a recorded real district (1,196 junctions):
> set `DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml`.

## Run from source

### Requirements

| Tool | Version |
|---|---|
| C++ compiler | GCC 12+, Clang 15+ or Apple Clang 15+ |
| CMake | 3.22+ |
| SQLite 3 and zlib | development headers |
| Node.js / npm | 20+ / 9+ |
| Python | 3.10+ |
| Eclipse SUMO | optional |

<details>
<summary><b>Installing them</b></summary>

**macOS**

```bash
xcode-select --install
brew install cmake node python
```

**Ubuntu / Debian**

```bash
sudo apt-get install -y build-essential cmake git python3 libsqlite3-dev zlib1g-dev
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

**Windows**: use WSL 2 with Ubuntu, then follow the Ubuntu steps.

</details>

### Start

```bash
./launcher                                   # build what changed, start, open the observer
./launcher start --seed 382923               # a particular seed
./launcher start --seed 382923 --day-type weekend
./launcher start --speed 3 --duration 1800
./launcher start --osm-file data/fixtures/real_network.osm.xml   # offline
./launcher start --seed 42 --save-seed demo  # save the configuration
./launcher start --saved-seed demo           # replay it exactly
./launcher seeds list
./launcher console                           # interactive dashboard
./launcher logs                              # inspect logs
./launcher test                              # run the test suites
```

The first build takes a few minutes; later starts take seconds. The launcher
verifies the machine before every run and says what to fix when it cannot run.

### Build by hand

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j
npm ci --prefix ui-engine && npm run build --prefix ui-engine
./build/dstns_server --port 8090          # then: ./launcher start --seed 382923
```

Full details: [Installation](docs/getting-started/installation.md) and
[Building from source](docs/development/building.md).

## Using the observer

| Do | Control |
|---|---|
| Play, pause | ▶ / ❚❚ in the command rail |
| Faster or slower | 0.25× … 5× |
| Jump 15 minutes back or forward | « / » (backwards is exact: checkpoint replay) |
| Step one minute | ▸\| |
| Start the day over | ⟲ |
| A different city | ↻ next to the seed (**Generate a new world**) |
| Follow events automatically | **Auto Focus** in the sidebar |
| Layers, legends | **Layers** in the lower bar |
| A PDF of the day | **Export Report** |
| Learn the interface | **Tutorial** |

Walkthrough: [Your first simulation](docs/getting-started/first-simulation.md).
Reference: [Observer interface](docs/guide/observer-interface.md).

## Using the API

Everything the observer does is an HTTP call:

```bash
curl -s localhost:8090/api/v1/playback/status | python3 -m json.tool | head
curl -s -X POST localhost:8090/api/v1/playback/seek -d '{"target_time":"17:30:00"}'
curl -s localhost:8090/api/v1/view/traffic
curl -s -X PUT localhost:8090/api/v1/control/edges/412 -d '{"closed":true}'
curl -s -X POST localhost:8090/api/v1/control/undo -d '{"count":1}'
curl -s localhost:8090/api/v1            # the server's own route index
```

| Group | Routes |
|---|---|
| Playback | start, prepare, status, play, pause, seek, step, stop, reset |
| View | topology, snapshot, nodes, edges, places, signals, congestion, event queue, … |
| Control | speed, day, modules, road overrides, signals, rain, surges, undo/redo |
| System | health, info, map status, backpressure, terminate |

Guide: [API](docs/api/index.md) · Reference: [routes](docs/api/reference.md) ·
[OpenAPI](docs/api/openapi.yaml) · [Errors](docs/api/errors.md)

> [!IMPORTANT]
> There are no user accounts: anyone who can reach the port can watch and
> control the run, and only the operator CLI (which holds `logs/operator.token`)
> can start one. Browser pages on other origins cannot change anything. Bind to
> `127.0.0.1` or use the TLS gateway on untrusted networks — see
> [Security](docs/deployment/security.md).

## Configuration

| File / flag | Controls |
|---|---|
| `config/defaults.json` | Run defaults: duration, speed, day, modules, map limits, port |
| `config/ui-config.json` | The observer's starting state: time format, layers, Auto Focus, notifications |
| `./launcher start --…` | Per-run seed, day type, speed, duration, map |
| `dstns_server --…` | Host, port, logs and map directories, map cache policy |
| `DSTNS_*` environment | Operator token, allowed origins, regeneration, Overpass endpoints, Docker run settings |

Every setting: [Configuration](docs/guide/configuration.md).

## Testing

```bash
./scripts/test.sh                                   # everything
ctest --test-dir build --output-on-failure          # 14 native and HTTP suites
npm test --prefix ui-engine                         # 286 observer tests
python3 tests/api/api_smoke.py --server build/dstns_server
./build/dstns_replay_verify 382923                  # reproducibility check
```

CI runs the native, HTTP, observer, documentation and Docker builds on every
push. Details: [Testing](docs/development/testing.md).

## Project layout

```text
apps/dstns_server/    server entry point
include/dstns/, src/  the C++ core: engine, API, scenario, OSM, events, backpressure
ui-engine/            the observer (React, Vite, Vitest)
dstns-operator-cli/   the operator CLI
tests/                native, HTTP and CLI suites, fixtures
tools/                scenario export, replay verification, road index, benchmark
docker/               entrypoint, dstns-run, TLS gateway
config/               defaults.json, ui-config.json
docs/                 documentation (MkDocs, published on Read the Docs)
```

## Documentation

**<https://dstns.readthedocs.io/>** — or browse [`docs/`](docs/index.md):

| Start here | Understand it | Integrate and run it |
|---|---|---|
| [Quick start](docs/getting-started/quick-start.md) | [Architecture](docs/concepts/architecture.md) | [API guide](docs/api/index.md) |
| [Installation](docs/getting-started/installation.md) | [Simulation engine](docs/concepts/simulation-engine.md) | [Docker deployment](docs/deployment/docker.md) |
| [Run with Docker](docs/getting-started/docker.md) | [Mathematical model](docs/concepts/mathematical-model.md) | [Security](docs/deployment/security.md) |
| [Your first simulation](docs/getting-started/first-simulation.md) | [Seeds and places](docs/guide/seeds-and-places.md) | [Configuration](docs/guide/configuration.md) |
| [Operator CLI](docs/guide/operator-cli.md) | [Reproducibility](docs/concepts/reproducibility.md) | [Troubleshooting](docs/troubleshooting.md) |

Preview the site locally:

```bash
python3 -m venv .venv-docs && .venv-docs/bin/pip install -r docs/requirements.txt
.venv-docs/bin/mkdocs serve        # http://127.0.0.1:8000
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `MAP_FETCH_FAILED` | No route to OpenStreetMap: check the network, set `DSTNS_OVERPASS_ENDPOINTS`, or run a cached / bundled map with `--osm-file` |
| Port 8090 in use | The CLI picks the next free port; with Docker set `DSTNS_HOST_PORT` |
| Observer shows **DEGRADED** | The browser is behind; DSTNS slows itself to match and recovers on its own |
| `CROSS_ORIGIN_FORBIDDEN` | A page on another origin tried to change state; allow it with `DSTNS_ALLOWED_ORIGINS` |
| Build fails after a system update | `cmake --fresh -S . -B build -DCMAKE_BUILD_TYPE=Release` |
| SUMO reported unavailable | `sumo --version` must work; reinstall or rebuild SUMO |

More: [Troubleshooting](docs/troubleshooting.md) and [FAQ](docs/faq.md).

## Contributing

Issues and pull requests are welcome. Please read
[Contributing](docs/development/contributing.md): every change comes with a
test that fails without it, all suites green, and documentation updated.

## License

Copyright © 2026 Varun Karthic. DSTNS is free software under the
[GNU Affero General Public License v3.0 or later](LICENSE). If you offer a
modified DSTNS over a network, you must offer its source to its users.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
ODbL 1.0. See [License](docs/license.md) for third-party components.
