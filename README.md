# DSTNS: Deterministic Spatiotemporal Transport Network Simulator

**Deterministic Simulated Environment** developed by **Varun Karthic** · **Version 1.0.0**

DSTNS is a high-performance C++20 urban road network scenario compiler, simulation runtime, and telemetry engine with an embedded React/Vite operator interface. It provides bit-for-bit reproducible traffic dynamics, signal phase controllers, public transit routing, dynamic weather cells (DWS), flooding models, and microscopic SUMO physics export.

---

## Key Highlights

- **128-Bit Determinism**: Counter-addressed Philox RNG domains, stable canonical IDs, and SHA-256 graph/scenario verification.
- **OpenStreetMap (OSM) Ingestion**: Direct ingestion of real-world OSM XML road networks, filtering non-vehicle paths, and indexing nodes, edges, and geometries.
- **Interactive Control API**: Dynamic transit bus route dispatching with adjacency verification, road closures, dynamic weather (100m–600m), and traffic surges.
- **Microscopic Physics Integration**: Native export of deterministic road networks to Eclipse SUMO (`netconvert` / `sumo`) for microscopic physics validation.
- **Rich Operator Dashboard**: Live canvas visualization, reduced motion mode, telemetry ledger, signal phase inspector, and printable audit reports.
- **Docker Compose Ready**: Single-command deployment with host port mapping and persistent volume storage.

---

## Quick Start Guide

### 1. Interactive Operator Launcher
The simplest way to start DSTNS locally:

```bash
python3 launcher.py
```
* **Menu Options**:
  * `[1]` Start DSTNS Server (Web UI & Simulation Engine)
  * `[2]` View System & Runtime Logs
  * `[3]` Modify Default Configuration
  * `[4]` Run Test Cases (Unit, Replay, SUMO, UI)
  * `[5]` Reset Runtime State

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
* **API Endpoint**: [http://127.0.0.1:8090/api/v1/playback/status](http://127.0.0.1:8090/api/v1/playback/status)
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

# List all nodes with facility anchors
curl -s http://127.0.0.1:8090/api/v1/view/topology | jq '.data.nodes[] | {id: .id, lat: .position.lat, lon: .position.lon, roles: .roles}'
```

### 2. Simulation Playback Lifecycle (`/api/v1/playback/*`)

#### A. Prepare Scenario with Seed (Standby / Inspection)
Loads the compiled map and facilities without advancing the virtual clock:
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

#### C. Pause, Resume, Stop, and Reset
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

### 3. Public Transit Route Dispatcher (`POST /api/v1/control/transit/route`)
Dispatches a transit bus along a validated sequence of contiguous road network nodes. The bus is rendered dynamically on the live map and serialized in snapshot telemetry:

```bash
# Dispatch Transit Bus on adjacent nodes [213, 6]
curl -X POST http://127.0.0.1:8090/api/v1/control/transit/route \
  -H "Content-Type: application/json" \
  -d '{
    "bus_id": "BUS-METRO-101",
    "label": "Downtown Express Shuttle",
    "nodes": [213, 6]
  }'
```

**Response**:
```json
{
  "ok": true,
  "valid": true,
  "bus_id": "BUS-METRO-101",
  "label": "Downtown Express Shuttle",
  "node_count": 2,
  "route_edges": [0],
  "total_distance_m": 16.25,
  "message": "Single linked list transit route validated successfully."
}
```

### 4. Dynamic Weather Injection (`POST /api/v1/control/events/weather`)
Injects a dynamic rain cell with an automatic random radius between $100\text{m}$ and $600\text{m}$:
```bash
curl -X POST http://127.0.0.1:8090/api/v1/control/events/weather \
  -H "Content-Type: application/json" \
  -d '{"epicenter_node": 10}'
```

### 5. Live State Snapshot (`GET /api/v1/view/snapshot`)
Returns instantaneous edge speeds, vehicle counts, signal lights, active rain storms, and dispatched buses:
```bash
curl -s http://127.0.0.1:8090/api/v1/view/snapshot | jq .
```

---

## Testing & Quality Assurance

Run the comprehensive test suite spanning C++ unit tests, property invariants, replay bit-reproducibility, SUMO integration, and UI testing:

```bash
# Run all tests via launcher
python3 launcher.py test all

# Or run individual test runners:
ctest --test-dir build --output-on-failure
npm test --prefix ui-engine
python3 tests/api/api_smoke.py --server build/dstns_server
bash tests/integration/sumo_smoke.sh
./build/dstns_replay_verify
./build/dstns_benchmark
```

---

## Detailed Documentation Directory

* [REST API Reference](docs/api/README.md)
* [View & Map Telemetry API Guide](docs/api/view-api.md)
* [Playback & Lifecycle API Guide](docs/api/playback-api.md)
* [Control & Transit Dispatcher API Guide](docs/api/control-api.md)
* [Docker & Compose Deployment Guide](docs/DOCKER.md)
* [Architecture & System Design](docs/ARCHITECTURE.md)
* [Mathematical Model & Physics Coupling](docs/MATHEMATICAL_MODEL.md)
