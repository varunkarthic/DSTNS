# DSTNS: Deterministic Spatiotemporal Transport Network Simulator

**Deterministic Simulated Environment** developed by **Varun Karthic** · **Version 1.0.0**

DSTNS is a high-performance C++20 urban road network scenario compiler, simulation runtime, and telemetry engine with an embedded React/Vite operator interface. It provides bit-for-bit reproducible traffic dynamics, signal phase controllers, public transit routing, Deterministic Weather Simulation (DWS), first-class incident disruptions, flooding models, and microscopic SUMO physics export.

---

## Key Highlights

- **128-Bit Determinism & Cryptographic Sub-Seeds**: A master 128-bit seed cryptographically derives independent sub-seeds (`map`, `dws`, `traffic`, `incidents`, `events`, `scenario`) via SHA-256 (`Seed128::derive`), ensuring complete subsystem isolation and $\ge 40$ bit avalanche diffusion on single-bit seed perturbations.
- **Geographic Diversity & OSM Ingestion**: Direct ingestion of real-world OpenStreetMap (OSM) XML road networks, Connected Radial Frontier Growth (CRFG), canonical 0-indexed entity sorting (DRNCP), and a 16-city worldwide metropolitan catalog (Tokyo, London, New York, Paris, Berlin, Singapore, Sydney, Toronto, Mumbai, Seoul, São Paulo, Cairo, San Francisco, Amsterdam, Stockholm, Dubai).
- **Deterministic Weather Simulation (DWS)**: Continuous compact-support Wendland $C^2$ radial kernels modeling storm cell kinematics, precipitation rates, surface runoff, road friction loss, and dynamic flash flooding.
- **First-Class Incident Management**: Guaranteed $\ge 4$ incidents per day distributed across early, midday, and late time slots, inducing real physical road closures and speed/capacity attenuations with clean overlapping resolution.
- **Zero-Leak Simulation Reset**: Total purge of active overlays, storm cells, traffic surges, signal overrides, transit buses, and monotonic ID counters between runs.
- **Interactive Control API**: Public transit bus route dispatching with adjacency verification, road closures, deterministic weather cells (100m–600m), and traffic surges.
- **Microscopic Physics Integration**: Native export of deterministic road networks to Eclipse SUMO (`netconvert` / `sumo`) for microscopic car-following validation.
- **Rich Operator Dashboard**: Live canvas visualization, reduced motion mode, telemetry ledger, signal phase inspector, and printable audit reports.
- **Docker Compose Ready**: Single-command container deployment with host port mapping and persistent volume storage.

---

## Quick Start Guide

The sandbox loads the bundled Berlin OpenStreetMap road network on startup and seed changes. The Docker image includes this map at `/app/maps/downtown_osm.xml`, outside the persistent `/app/data` volume so existing volumes cannot hide it. Missing map data produces an error; synthetic grids are reserved for explicit test fixtures. The UI preserves local geographic proportions when fitting and focusing the map.

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

* **CLI Commands & Flags (Non-Interactive Automation)**:
  * `start [--open]`: Build engine & Web UI bundle, launch server, and optionally open browser
  * `ui [open|dev|build|install]`: Manage frontend bundle, live Vite dev server, or browser
  * `logs [system|api|event|playback]`: Inspect live SQLite WAL logs or text logs
  * `config`: View and edit persisted runtime defaults
  * `test [all|unit|api|replay|benchmark|sumo|ui]`: Execute test suites with structured status reporting
  * `sumo`: Run standalone microscopic Eclipse SUMO traffic simulation
  * `reset [--yes]`: Clear ephemeral checkpoints, runtime databases, and live runs

### 2. Manual Local Execution
```bash
# Terminal 1: Build & Launch C++ Engine
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j4
./build/dstns_server --host 127.0.0.1 --port 8090 --logs logs

# Terminal 2 (Optional for UI development):
cd ui-engine
npm install
npm run dev
```

* **Web UI Dashboard**: [http://127.0.0.1:8090/](http://127.0.0.1:8090/)
* **API Playback Status**: [http://127.0.0.1:8090/api/v1/playback/status](http://127.0.0.1:8090/api/v1/playback/status)
* **API Health Check**: [http://127.0.0.1:8090/health](http://127.0.0.1:8090/health)

### 3. Docker Compose Deployment
```bash
# Build and run container stack in background
docker compose up --build -d

# Follow container logs
docker compose logs -f

# Stop container
docker compose down
```

---

## Core API Usage

### 1. Fetching Map Topology (`GET /api/v1/view/topology`)
Fetches the complete compiled road network, geographic bounding box, nodes with facility roles (Bus Stops, Signals, Schools, Malls, Offices), and polyline edge geometries:

```bash
# Fetch full topology JSON
curl -s http://127.0.0.1:8090/api/v1/view/topology | jq .

# Extract map bounds and center coordinates
curl -s http://127.0.0.1:8090/api/v1/view/topology | jq .data.bounds
```

### 2. Simulation Playback Lifecycle (`/api/v1/playback/*`)

#### A. Prepare Scenario with Seed (Standby / Inspection)
Loads the compiled map, DWS weather cells, and incidents without advancing the virtual clock:
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/prepare \
  -H "Content-Type: application/json" \
  -d '{"seed": "9876543210987654", "playback_duration_seconds": 1200, "day": 0}'
```

#### B. Start Simulation Run
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/start \
  -H "Content-Type: application/json" \
  -d '{"seed": "9876543210987654", "playback_duration_seconds": 600, "day": 1}'
```

#### C. Pause, Resume, Seek, and Reset
```bash
# Pause simulation clock
curl -X POST http://127.0.0.1:8090/api/v1/playback/pause -H "Content-Type: application/json" -d '{}'

# Resume simulation clock
curl -X POST http://127.0.0.1:8090/api/v1/playback/play -H "Content-Type: application/json" -d '{}'

# Jump / Seek to specific time of day
curl -X POST http://127.0.0.1:8090/api/v1/playback/seek \
  -H "Content-Type: application/json" \
  -d '{"target_time": "14:30:00"}'
```

### 3. Incident Subsystem Query (`GET /api/v1/view/incidents`)
Returns all scheduled, active, and resolved incidents:
```bash
curl -s http://127.0.0.1:8090/api/v1/view/incidents | jq .
```

### 4. Public Transit Route Dispatcher (`POST /api/v1/control/transit/route`)
Dispatches a transit bus along a validated sequence of contiguous road network nodes:

```bash
curl -X POST http://127.0.0.1:8090/api/v1/control/transit/route \
  -H "Content-Type: application/json" \
  -d '{
    "bus_id": "BUS-METRO-101",
    "label": "Downtown Express Shuttle",
    "nodes": [213, 6]
  }'
```

### 5. Deterministic Weather Injection (`POST /api/v1/control/events/weather`)
Injects a localized storm cell with a radius of $350\text{m}$:
```bash
curl -X POST http://127.0.0.1:8090/api/v1/control/events/weather \
  -H "Content-Type: application/json" \
  -d '{"epicenter_node": 10}'
```

### 6. Live State Snapshot (`GET /api/v1/view/snapshot`)
Returns instantaneous edge speeds, vehicle counts, signal lights, active storm cells, dispatched buses, and active incidents:
```bash
curl -s http://127.0.0.1:8090/api/v1/view/snapshot | jq .
```

---

## Testing & Quality Assurance

Run the comprehensive test suite spanning C++ unit tests, REST API endpoints, bit-reproducible replay, performance benchmarks, SUMO microscopic integration, and Web UI validation:

```bash
# Run all 9 verification stages via operator CLI
./launcher test all

# Or run individual test targets:
./launcher test unit        # Native C++ unit & property tests (test_graph, test_dws, test_incident, test_bpr)
./launcher test api         # REST API lifecycle & endpoint integration (82 assertions)
./launcher test replay      # Deterministic replay bit-reproducibility
./launcher test benchmark   # Performance throughput benchmarks
./launcher test sumo        # Eclipse SUMO microscopic traffic simulation
./launcher test ui          # Web UI TypeScript, Vite bundle & preview
```

---

## Technical Documentation Directory

* [Operator Console (dstns-operator-cli)](docs/operator-cli.md)
* [System Architecture Overview](docs/ARCHITECTURE.md)
* [Deterministic Seeding & Sub-Seeds](docs/deterministic-seeding.md)
* [OpenStreetMap Ingestion & City Catalog](docs/osm-map-generation.md)
* [Deterministic Weather Simulation (DWS)](docs/dws.md)
* [Incident Subsystem & Disruption Physics](docs/incidents.md)
* [Simulation Engine & State Reset](docs/simulation-engine.md)
* [Event Stack & Telemetry Engine](docs/events.md)
* [Playback Control & Simulation Lifecycle](docs/playback-control.md)
* [Spatiotemporal Graph Model](docs/graph-model.md)
* [Routing Engine & Shortest Paths](docs/routing.md)
* [Unified REST API Reference](docs/api.md)
* [Testing Architecture & Verification](docs/TESTING.md)
* [Docker & Compose Deployment Guide](docs/DOCKER.md)
* [Mathematical Model & Physics Coupling](docs/MATHEMATICAL_MODEL.md)
* [Engineering Context Master Journal](context/issue_context.md)
* [System Architecture Context](context/architecture_context.md)
* [Structured Bug Audit](context/bug_audit.md)
* [Testing Context & Verification Log](context/testing_context.md)
