# Architecture

DSTNS is one C++20 process that owns the simulation and serves it over HTTP,
an operator CLI that builds, starts and supervises that process, and a React
observer that watches a run in the browser. This page describes how those parts
fit together, which threads exist and what they own, how a run moves through
its lifecycle, and where each concern lives in the source tree.

## Contents

- [System overview](#system-overview)
- [Source layout](#source-layout)
- [The core process](#the-core-process)
  - [Threads and locking](#threads-and-locking)
  - [From seed to world](#from-seed-to-world)
  - [Static and dynamic state](#static-and-dynamic-state)
  - [The virtual clock](#the-virtual-clock)
- [Run lifecycle](#run-lifecycle)
- [The HTTP layer](#the-http-layer)
- [The observer](#the-observer)
- [The operator CLI](#the-operator-cli)
- [Deployment shapes](#deployment-shapes)
- [Determinism boundaries](#determinism-boundaries)
- [Related documents](#related-documents)

## System overview

```
 ┌────────────────────┐   spawn, X-DSTNS-Operator     ┌───────────────────────────────────────┐
 │ Operator CLI       │ ────────────────────────────▶ │ dstns_server (C++20)                  │
 │ dstns-operator-cli │   POST /playback/start        │                                       │
 │  build · start ·   │                               │  ApiServer (cpp-httplib)              │
 │  test · logs ·     │ ◀── /health, /status ──────── │    │ routes, validation, CSRF guard   │
 │  seeds · sumo      │                               │    ▼                                  │
 └────────────────────┘                               │  SimulationEngine                     │
                                                      │    ├─ ScenarioCompiler ─▶ OSM loader  │
 ┌────────────────────┐   GET /view/*, /news          │    │                    ─▶ downloader │
 │ Observer (React)   │ ◀──────────────────────────── │    ├─ GraphStore (static + dynamic)   │
 │ ui-engine          │   POST /playback/*, /world/*  │    ├─ EventRuntime (signals, demand)  │
 │  map · rail ·      │ ────────────────────────────▶ │    ├─ AdaptiveBackpressure (ASB)      │
 │  telemetry · PDF   │   POST /system/backpressure   │    └─ SumoBridge ─▶ netconvert, sumo  │
 └────────────────────┘                               │  RuntimeLogger ─▶ logs/system.log,    │
                                                      │                   logs/runtime.db     │
                                                      └───────────────────────────────────────┘
```

The core is the single authority. The CLI decides *what* runs: seed, map,
day type, duration, speed. The observer decides only *how it is watched*,
apart from a small set of playback controls and world regeneration. Neither
holds simulation state of its own; both read what the core publishes.

## Source layout

| Path | Contents |
|---|---|
| `apps/dstns_server/main.cpp` | Process entry: flags, operator credential, cache sweep, engine and API start-up |
| `include/dstns/`, `src/` | The core library `dstns_core` |
| `src/engine.cpp` | `SimulationEngine`: lifecycle, clock, physics step, checkpoints, controls, undo/redo, views |
| `src/api.cpp` | `ApiServer`: every HTTP route, request validation, error mapping, CSRF guard |
| `src/scenario.cpp` | `ScenarioCompiler`: seed and config to a complete `Scenario` (graph, signals, stops, trips, weather, incidents) |
| `src/osm.cpp` | `OsmRoadLoader`: OSM XML to a connected, canonically numbered road graph and its places |
| `src/osm_fetch.cpp` | On-demand map download through `scripts/fetch_osm.py`, progress, cache sweep |
| `src/geo.cpp` | The 181-city catalogue and seed-to-location resolution |
| `src/graph.cpp` | `GraphStore` (static graph plus per-tick dynamic arrays) and `RoutePlanner` (A*) |
| `src/events.cpp` | `EventRuntime`: signal controller heap, demand schedule, couplings, event history |
| `src/demand.cpp` | Place taxonomy, diurnal demand curves, demand couplings, bus-stop thinning |
| `src/asb.cpp` | Adaptive Simulation Backpressure |
| `src/rng.cpp` | `Seed128`, SHA-256 sub-seed derivation, counter-based Philox RNG |
| `src/sumo_bridge.cpp` | SUMO detection, export, `netconvert` and `sumo` invocation |
| `src/logging.cpp` | `RuntimeLogger`: text system log and SQLite runtime journal |
| `src/utf8.cpp` | UTF-8 repair and JSON serialisation guard for untrusted text |
| `ui-engine/` | The observer: React 19, Vite, Vitest, jsPDF |
| `dstns-operator-cli/` | The operator CLI (Node 20+), saved-seed store (`seeds.py`) |
| `launcher`, `launcher.py` | Thin wrappers that start the CLI |
| `scripts/` | Build, test, fetch and reset helpers |
| `tests/` | Native unit, property, replay and performance suites; HTTP and CLI suites |
| `tools/` | `dstns_scenario_export`, `dstns_road_index`, `dstns_replay_verify`, `dstns_benchmark` |
| `docker/`, `Dockerfile`, `docker-compose.yml` | Container build and TLS gateway |
| `config/` | `defaults.json` (run defaults) and `ui-config.json` (observer defaults) |

## The core process

### Threads and locking

| Thread | Created by | Does |
|---|---|---|
| HTTP workers | cpp-httplib's thread pool | Parse requests, call the engine, serialise responses |
| Engine loop (`worker_`) | `SimulationEngine` constructor | Wakes every 50 ms; while `RUNNING`, advances the model to where the wall clock says it should be; writes `global_view.json` every 10 s |
| World worker (`world_worker_`) | `start_async`, `regenerate_world` | Compiles a scenario (possibly downloading a map) off the request thread, then installs it |
| Downloader child | `osm_fetch.cpp` via `posix_spawn` | Runs `scripts/fetch_osm.py` in its own process group, so termination can kill it and its descendants |
| Shutdown worker | `terminate` handler | Stops the listener; a detached 3 s backstop guarantees the process exits |

One mutex, `SimulationEngine::mutex_`, guards all simulation state. Every view
and every control takes it, so a response is always a coherent picture of
one instant. Compilation deliberately runs **without** the lock: a map
download can take a minute, and status, health and map progress must stay
readable throughout. Three mechanisms make that safe:

- **A compile lease** (`CompileLease`, an atomic flag) means at most one compile
  is in flight. A second start or regeneration gets HTTP 409.
- **A compile generation counter.** Every start, prepare, reset or regeneration
  increments `compile_generation_`, and a compile installs its result only if
  the counter has not moved since it began. A reset during a download therefore
  discards the downloaded world rather than installing it.
- **A lock-free lifecycle mirror.** `transition()` mirrors the lifecycle into an
  atomic, so `/health` answers without the mutex.

SUMO runs follow the same rule: `sumo_simulate` copies the scenario under the
lock and runs the external tools without it.

### From seed to world

```
Seed128 ──▶ geo: city + anchor (urban-crfg-v3) ──▶ map tile on disk?
   │                                                  │ no: fetch_osm.py (Overpass)
   │                                                  ▼
   │                         OsmRoadLoader: parse, CRFG district growth,
   │                         canonical IDs, true-metre projection, places
   ▼                                                  │
 sub-seeds (SHA-256 domains) ─────────▶ ScenarioCompiler
                                         ├─ signals (snapped to junctions, green waves)
                                         ├─ bus stops (coverage and spacing)
                                         ├─ trips (A* over legal directions)
                                         ├─ weather schedule (DWS)
                                         ├─ incidents (at least 4, spread across the day)
                                         └─ hashes: map, graph, event, scenario
                                                      │
                                                      ▼
                                   GraphStore + EventRuntime installed; READY or RUNNING
```

See [deterministic seeding](deterministic-seeding.md), [OSM map
generation](osm-map-generation.md) and [graph model](graph-model.md).

### Static and dynamic state

`GraphStore` keeps the compiled `Scenario` immutable and holds two dynamic
arrays alongside it, one `NodeDynamic` per node and one `EdgeDynamic` per
directed edge. Each physics step rewrites the dynamic arrays and then
`commit()` bumps `state_revision`. Topology never changes during a run, so the
observer fetches it once per `run_id` and then polls only snapshots.

### The virtual clock

A run simulates one day, 86,400 virtual seconds, in `playback_duration_s`
wall-clock seconds (60 to 3600) at the base rate, scaled by the tick rate
(greater than 0, at most 5). The engine loop computes

```
target = anchor_virtual_s + (now - anchor_wall) × (86400 / playback_duration_s) × tick_rate
```

and steps the physics one virtual second at a time up to `target`. Every rate
change, pause, play or seek first catches up to the wall clock and then
re-anchors, so changing the rate never applies retroactively. Physics always
advances in one-second steps whatever the rate, so the rate changes pacing,
never results.

## Run lifecycle

```
            start / prepare                    compile ok
  IDLE ───────────────────────▶ PREPARING ─────────────────▶ READY ──play──┐
   ▲                               │ compile fails (error kept)            │
   │◀──────────────────────────────┘                                       ▼
   │  reset                                     pause ┌──────────────── RUNNING
   ├───────────────────────────────────────────────── │                    │
   │                                                  └────▶ PAUSED ◀──────┤
   │                                                   play ─────▶ RUNNING │
   │                                                                       │ 24:00:00
   │                                     seek/step to 24:00:00             ▼
   │                                    ────────────────────────────▶ COMPLETED
   │        stop
   ├──────────────── STOPPED ◀── STOPPING ◀── (any run state)
   │
   └─ terminate ──▶ TERMINATING ──▶ process exits
```

`SEEKING` is a transient state held while a seek or step replays physics. A
seek from `COMPLETED` back into the day pauses there, or runs if `play` was
requested. World regeneration pauses the current world, compiles the new one
in the background, and installs it `PAUSED` at 00:00:00. If that compile fails,
the old world is left exactly as it was.

## The HTTP layer

`ApiServer` registers every route in one function, `routes()`, and serves the
built observer from `ui-engine/dist`. Three cross-cutting pieces sit in front
of every handler:

1. **The pre-routing guard** refuses cross-site state changes
   (`CROSS_ORIGIN_FORBIDDEN`) and starts that lack the operator credential
   (`CLI_START_REQUIRED`). See [Security](SECURITY.md).
2. **The exception handler** maps C++ exception types to HTTP statuses and
   stable error codes, so handlers validate by throwing. See
   [API errors](api/errors.md).
3. **The access logger** records method, path and status in the SQLite journal.

Every read view uses the same envelope (`run_id`, `seed`, `state_revision`,
`config_revision`, `clock`, `data`), so a client can always tell which run and
which instant a payload describes. See the [API reference](api.md).

## The observer

The observer is a single-page React application. `useSimulation` polls
`/playback/status` once a second, then `/view/snapshot` and `/news`, and
fetches `/view/topology` only when `run_id` changes. `useBackpressure` reports
the observer's lag and frame time to `/system/backpressure`, and the core
answers with what the interface may do: slow down, lock speed, disable motion,
or suspend. Everything else (the map canvas, the command rail, telemetry,
notifications, Auto Focus, the PDF report) derives from those polls. See
[Observer interface](observer-interface.md) and
[ASB](asb.md).

## The operator CLI

`dstns-operator-cli/dstns.mjs` is the only supported way to start a run. It
rebuilds the native core and the observer when their sources have changed,
reuses a healthy server on the configured port or picks a free one, waits for
health, opens the observer, waits for it to load, and then posts the start
request with the operator credential the server wrote to `logs/operator.token`.
It also runs the test suites, reads logs, edits defaults and manages saved
seeds. See [Operator CLI](operator-cli.md).

## Deployment shapes

| Shape | How | Notes |
|---|---|---|
| Local, recommended | `./launcher` | Builds as needed, binds `0.0.0.0:8090` by default, serves the observer itself |
| UI development | `npm run dev --prefix ui-engine` against a running core | Vite proxies `/api`, `/health` and `/media` to `DSTNS_API_PORT` (default 8090), so requests stay same-origin |
| Containers | `docker compose up` | Engine, UI and an nginx TLS gateway on 8443. See [Docker](DOCKER.md) |

## Determinism boundaries

Everything that affects simulation results derives from the seed and the
resolved configuration: map choice, district, signals, stops, trips, weather,
incidents and demand noise. Things that deliberately do **not** feed back into
results:

- wall-clock pacing and the tick rate;
- the observer and anything it displays;
- ASB, which governs pacing only;
- SUMO, which is a separate batch adapter and never writes back into the
  aggregate model.

Operator controls (overrides, toggles, surges, manual rain) are part of a run's
history and change its results from the moment they are applied. See
[Reproducibility](REPRODUCIBILITY.md).

## Related documents

- [Simulation engine](simulation-engine.md): the physics step, checkpoints, controls and undo
- [API reference](api.md) and [errors](api/errors.md)
- [Security](SECURITY.md)
- [Configuration](CONFIGURATION.md)
- [Testing](TESTING.md)
- [Mathematical model](MATHEMATICAL_MODEL.md)
