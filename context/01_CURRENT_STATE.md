# Current State (01) — 2026-09-07

## Implemented and Current Verification
- **C++20 Core Library (`dstns_core`)**:
  - Philox counter-based deterministic RNG and 128-bit seed model.
  - OSM XML road network extraction with highway filtering and bidirectional normalization.
  - Scenario compiler (nodes, reverse-twin edges, bus stops, buildings, signals, DWS storms, trips).
  - GraphStore with static/dynamic separation and deterministic A* routing.
  - SimulationEngine with three-clock scaling, single-writer command queue, periodic checkpoints, seeking, and undo/redo overlays.
  - Dual persistence: SQLite WAL (`runtime.db`) and human-readable text logs (`system.log`).
  - REST & SSE API server (`cpp-httplib`).
- **Dedicated CLI Tools**:
  - `dstns_scenario_export`: Exports scenario into SUMO plain-XML network and route files.
  - `dstns_road_index`: Inspects and canonicalizes OSM road networks.
  - `dstns_replay_verify`: Verifies exact cryptographic hash matching and seek reconstruction.
  - `dstns_benchmark`: Micro-benchmarking compilation, routing, and snapshot generation; run it locally for current measurements.
- **Automated Test Suites (latest local run passing; see `context/issue_context.md` for exact commands and unavailable gates)**:
  - `dstns_unit_tests`: Primitives, RNG, scenario compilation, and engine lifecycle.
  - `dstns_property_invariants`: Static and simulated dynamic bounds plus closure-aware routing.
  - `dstns_replay_reproducibility`: Independent engine snapshot equality for grid and OSM scenarios.
  - `dstns_performance_smoke`: Connected-fixture check and enforced mean routing ceiling.
  - `api_smoke.py`: 79 end-to-end HTTP API lifecycle and error-contract assertions.
  - `sumo_smoke.sh`: SUMO `netconvert` and headless microscopic physics validation.
  - `vitest`: UI Engine API decoding and overlay client validation.
- **UI Engine (`ui-engine`)**:
  - React 19 + TypeScript + MapLibre GL JS client for canonical road map rendering.
  - Independent Node.js Fastify server for UI Overlay API (`/ui-api/v1/*`).
- **Container Deployment**:
  - Multi-stage Dockerfile and `docker-compose.yml` serve the unified backend and compiled UI over HTTP on port 8090.
  - Compose configuration, image build, container health, host HTTP, and browser rendering are verified in the 2026-09-07 final audit; this repository does not currently configure an HTTPS gateway.
