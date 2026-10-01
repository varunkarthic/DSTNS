# DSTNS

**Deterministic Spatiotemporal Transport Network Simulator.** A C++20
simulation core, an operator CLI and a React observer. A seed picks a real city
district from OpenStreetMap and simulates a full day of traffic on it, with
scheduled signals, place-driven demand, weather, flooding and incidents, all on
one authoritative virtual clock. The same seed always produces the same world
and the same day.

```
CLI ──start──▶ dstns_server ──▶ SimulationEngine ──▶ GraphStore / EventRuntime
                    │                                         │
                    └──── revisioned HTTP API ◀───────────────┘ ──▶ observer (browser)
```

## Contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [Running a simulation](#running-a-simulation)
- [Building and testing](#building-and-testing)
- [Documentation](#documentation)
- [Project status](#project-status)
- [Licence](#licence)

## Highlights

- **Real places, chosen by the seed.** The seed resolves to one of 181 cities
  on every inhabited continent and a district inside it. The city's extract is
  downloaded from OpenStreetMap once and cached; every later seed in that city
  reuses it.
- **True metric scale.** Positions and lengths are real metres, checked against
  haversine ground truth to within 0.13%. Display scaling never feeds back into
  the model.
- **Deterministic to the bit.** A 128-bit seed derives independent sub-seeds
  per subsystem through SHA-256; physics advances in fixed one-second steps;
  seeking and playing to the same time give identical state; two independent
  engines with the same seed agree exactly.
- **A living network.** Signals snapped to real junctions and coordinated in
  green waves; demand from schools, offices, shops and stops following
  weekday and weekend curves and reacting to closures, rain and incidents;
  storms modelled with Wendland C² kernels; flooding that closes roads; at
  least four incidents a day.
- **Time travel.** Pause, step, seek backwards and forwards through the day
  with checkpoint replay, and undo and redo operator controls.
- **An observer built for watching.** A live map, telemetry, notifications
  with Do Not Disturb, Auto Focus on events, a guided tutorial and a PDF
  report. Adaptive backpressure keeps a slow browser in step.
- **SUMO cross-check.** Export any world to Eclipse SUMO and run it
  microscopically as a batch job.
- **Containers.** Docker Compose with an nginx TLS gateway.

## Quick start

Requirements: CMake 3.22+, a C++20 compiler, SQLite, zlib, Node.js 20+, npm
and Python 3. SUMO is optional.

```bash
./launcher
```

The launcher installs the CLI's dependencies, builds the core and the observer,
starts the server, opens `http://127.0.0.1:8090/` and starts a run from a
fresh seed. The interface narrates world selection, the map download (20 to 50
seconds the first time for a city) and generation as they happen.

## Running a simulation

```bash
./launcher start --seed 382923                    # a particular seed
./launcher start --seed 382923 --day-type weekend
./launcher start --speed 2 --duration 1800        # 2×, a day in 30 minutes at 1×
./launcher start --seed 42 --save-seed campus-test
./launcher start --saved-seed campus-test         # replay a saved configuration
./launcher seeds list
./launcher start --osm-file data/maps/cologne_x5000.osm.xml   # pin a map, offline
./launcher console                                # interactive dashboard
```

The seed is a plain number, and it names the run end to end: what you type is
what the interface shows and what reproduces the world. Extracts are cached at
`data/maps/<city>_x<extent>.osm.xml`. If a district cannot be downloaded, the
run fails with `MAP_FETCH_FAILED`, naming the city, the coordinates and the
cause; another city is never substituted, because that would break the link
between a seed and its place.

In the observer you can play and pause, step, skip back and forward, reset,
choose a speed from 0.25× to 5×, and generate a new world from a fresh seed.
Run configuration (seed, day type, map) belongs to the CLI. The interface needs
a window of at least 1024 × 640.

See [Operator CLI](docs/operator-cli.md) and [Observer
interface](docs/observer-interface.md).

## Building and testing

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j
ctest --test-dir build --output-on-failure        # 14 native and HTTP suites
python3 tests/api/api_smoke.py --server build/dstns_server
npm ci --prefix ui-engine && npm test --prefix ui-engine

./scripts/test.sh                                 # all of the above, and more
```

See [Testing](docs/TESTING.md) for every suite, the browser tests and
sanitizer builds.

## Documentation

**Start here**

| Document | For |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | How the parts fit together: processes, threads, lifecycle, source layout |
| [Operator CLI](docs/operator-cli.md) | Every command and flag, and what happens when a run starts |
| [Observer interface](docs/observer-interface.md) | The browser interface, control by control |
| [Configuration](docs/CONFIGURATION.md) | `defaults.json`, flags and environment variables |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Symptoms, causes and fixes |

**The model**

| Document | For |
|---|---|
| [Simulation engine](docs/simulation-engine.md) | The physics step, checkpoints and seeking, controls, undo, regeneration |
| [Mathematical model](docs/MATHEMATICAL_MODEL.md) | The formulas |
| [OSM map generation](docs/osm-map-generation.md) | Seed to city to district to graph |
| [Graph model](docs/graph-model.md) | Nodes, edges and their attributes |
| [Deterministic seeding](docs/deterministic-seeding.md) | Seeds, sub-seeds and the RNG |
| [Events](docs/events.md) | The event runtime and event queue |
| [Weather (DWS)](docs/dws.md), [Incidents](docs/incidents.md), [Routing](docs/routing.md) | Subsystems |
| [ASB](docs/asb.md) | Adaptive Simulation Backpressure |
| [Reproducibility](docs/REPRODUCIBILITY.md) | What is guaranteed, and how it is checked |

**Integrating**

| Document | For |
|---|---|
| [API guide](docs/api/README.md) and [API reference](docs/api.md) | Every route, request and response |
| [Playback API](docs/api/playback-api.md), [Control API](docs/api/control-api.md), [Errors](docs/api/errors.md) | Details |
| [SUMO adapter](docs/components/sumo-adapter.md) | Export and batch SUMO runs |
| [Security](docs/SECURITY.md) | Threat model, credentials, CSRF protection, validation |
| [Docker](docs/DOCKER.md), [Deployment](docs/DEPLOYMENT.md), [Logging](docs/LOGGING.md) | Operations |

**Engineering**

| Document | For |
|---|---|
| [Testing](docs/TESTING.md) | Every suite and how to run it |
| [Code evaluation, October 2026](docs/AUDIT-2026-10.md) | The latest review: defects found and fixed, and known issues |
| [Component notes](docs/components/README.md) | Per-component design notes |
| [Performance](docs/PERFORMANCE.md) | Benchmarks |

## Project status

The live model is aggregate (flows and queues per edge), not microscopic; the
observer's flow dots represent modelled edge flow, not individual vehicles.
SUMO runs separately and never writes back into a live run. Transit dispatch
is retired: `POST /api/v1/control/transit/route` returns HTTP 410, while
internal routing, bus stops and planned trips remain. The optional logo is
served from `/media/logo.png`; its absence is harmless.

## Licence

Copyright (C) 2026 Varun Karthic. AGPL-3.0-or-later; see `LICENSE` and
`COPYRIGHT`. Map data © OpenStreetMap contributors, ODbL 1.0. Because the
server is offered over a network, `GET /api/v1/system/source` tells every user
where to obtain the corresponding source.
