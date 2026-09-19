# DSTNS

Deterministic Spatiotemporal Transport Network Simulator: a C++20 simulation core, CLI operator console and React observation/analysis interface. Real OSM geography, independent scheduled signals, POI demand, weather, flooding and incidents share one authoritative virtual clock.

## Run

---

## Key Highlights

- **128-Bit Determinism & Cryptographic Sub-Seeds**: A master 128-bit seed cryptographically derives independent sub-seeds (`map`, `dws`, `traffic`, `incidents`, `events`, `scenario`) via SHA-256 (`Seed128::derive`), ensuring complete subsystem isolation and $\ge 40$ bit avalanche diffusion on single-bit seed perturbations.
- **Seed-Selected Cities, Downloaded On Demand**: The 128-bit seed derives both a metropolis from a 16-city catalog (Tokyo, London, New York, Paris, Berlin, Singapore, Sydney, Toronto, Mumbai, Seoul, São Paulo, Cairo, San Francisco, Amsterdam, Stockholm, Dubai) and coordinates within its urban core. The district is fetched from OpenStreetMap on demand and cached by seed-derived name, then processed through Connected Radial Frontier Growth (CRFG) and canonical 0-indexed entity sorting (DRNCP).
- **True Metric Scale**: Node positions and edge lengths are real metres from the projection origin, verified against haversine ground truth to within 0.13%. Display scaling is a client concern and never feeds back into the model.
- **Deterministic Weather Simulation (DWS)**: Continuous compact-support Wendland $C^2$ radial kernels modeling storm cell kinematics, precipitation rates, surface runoff, road friction loss, and dynamic flash flooding.
- **First-Class Incident Management**: Guaranteed $\ge 4$ incidents per day distributed across early, midday, and late time slots, inducing real physical road closures and speed/capacity attenuations with clean overlapping resolution.
- **Zero-Leak Simulation Reset**: Total purge of active overlays, storm cells, traffic surges, signal overrides, transit buses, and monotonic ID counters between runs.
- **Interactive Control API**: Public transit bus route dispatching with adjacency verification, road closures, deterministic weather cells (100m–600m), and traffic surges.
- **Microscopic Physics Integration**: Native export of deterministic road networks to Eclipse SUMO (`netconvert` / `sumo`) for microscopic car-following validation.
- **Rich Operator Dashboard**: Live canvas visualization, reduced motion mode, telemetry ledger, signal phase inspector, and printable audit reports.
- **Docker Compose Ready**: Single-command container deployment with host port mapping and persistent volume storage.

---

## Quick Start Guide

The seed chooses where the simulation happens. It resolves to one of sixteen cities and to coordinates inside that city, and the road network for a 4 km-wide district around that point is downloaded from OpenStreetMap the first time it is needed, then cached at `data/maps/<city>_<lat>_<lon>_r<radius>.osm.xml`.

Re-running a seed reuses its cached tile and needs no network. Re-rolling the seed lands somewhere else and downloads that district — a first download takes roughly 20–50 seconds. If it cannot be downloaded, startup fails with `MAP_FETCH_FAILED` naming the city, the coordinates and the cause; no substitute map is used, because that would break the correspondence between a seed and the place it denotes. Synthetic grids remain reserved for explicit test fixtures, and `--osm-file PATH` still pins a specific map.

Distances are real. Two junctions a kilometre apart are a kilometre apart in the model, and edge lengths are true metres; the UI compresses the picture for display only, which never affects the simulation.

### 1. Interactive Operator Console (`dstns-operator-cli`)
DSTNS features a modern terminal operator interface powered by `@poppinss/cliui` that manages the entire lifecycle, automatic Web UI building, server health monitoring, and test suites.

The console provides **Ubuntu Server (Subiquity) style navigation**:
* **`↑` / `↓` Arrow Keys** (or `k` / `j`): Navigate menu options.
* **`Space`**: Select / mark the highlighted option (`[●]`).
* **`Enter`**: Execute the selected (`[●]`) option.
* **`Esc`** (or `q`): Return to previous menu or exit console.

```bash
# Launch operator console (via root launcher or direct CLI)
./launcher
# or
python3 launcher.py
# or, for direct Node execution, install dependencies first
npm ci --prefix dstns-operator-cli
node dstns-operator-cli/dstns.mjs
```

### Non-Interactive Launcher Arguments

```
./launcher start --seed 382923 --day-type weekday
# Reusable configuration:
./launcher start --seed 42 --save-seed campus-test
./launcher start --saved-seed campus-test
./launcher seeds list
```

Open the URL printed by the CLI (normally `http://127.0.0.1:8090`). The browser observes the active run and offers playback (back, step, play and pause, forward, reset), speed, and generating a new world from a fresh seed. Startup and weekday/weekend configuration belong to the CLI; weekday is the default. The UI no longer injects incidents, closes roads or dispatches Transit routes.

For a larger pinned OSM source, run `python3 scripts/fetch_osm.py`, then `./launcher start`. The importer keeps a checksum manifest and refuses to overwrite existing data. Use `--osm-file PATH` to select an existing source. Saved seeds retain source bytes and deterministic configuration in a SQLite registry.

## Build and verify

Requirements: CMake, C++20 compiler, SQLite, zlib, Node.js 20+, npm and Python 3. SUMO/netconvert are optional for batch export validation.

```
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
python3 tests/api/api_smoke.py --server build/dstns_server
python3 tests/cli/test_seeds.py
npm ci --prefix dstns-operator-cli
npm ci --prefix ui-engine
npm test --prefix ui-engine
npm run build --prefix ui-engine
node ui-engine/tests/browser.mjs
node ui-engine/tests/browser-hud.mjs
```

Browser tests use installed Chrome (`CHROME_BIN` can override the executable), an isolated server on port 18191, and write screenshots/PDF evidence to `artifacts/modernization/browser/`.

## Architecture and documentation

`CLI → SimulationEngine → GraphStore/state → revisioned HTTP/SSE API → observer UI`.

The existing live runtime uses an aggregate traffic model; SUMO export/batch simulation is a separate adapter. UI flow dots represent modeled edge flow, not individual SUMO telemetry. All stochastic simulation behavior is seed derived; playback speed changes pacing without changing physics.

- [Modernization guide](docs/modernization.md): architecture, saved seeds, OSM, event queue, signals, demand, formulas, accessibility, reporting and limitations.
- [Observer interface guide](docs/observer-interface.md): command rail, time and progress, speed, seed and world regeneration, notifications, Do Not Disturb, Auto Focus, settings, tooltips, tutorial and the report
- [Observer configuration](docs/ui-configuration.md)
- [API reference](docs/api.md)
- [Validation and implementation journal](context/03_IMPLEMENTATION_PROGRESS.md)
- [Final requirement checklist](context/modernization_validation.md)

Transit dispatch is retired: its compatibility route returns HTTP 410. Internal routing, bus stops and scheduled trips remain. The optional logo is loaded from `/media/logo.png`; its absence is harmless.
