# Current State (01) — 2026-09-04

## Verified & Operational
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
  - `dstns_benchmark`: Micro-benchmarking compilation, routing (5.7 $\mu$s/query), and snapshot generation.
- **Automated Test Suites (100% Passing)**:
  - `dstns_unit_tests`: Primitives, RNG, scenario compilation, and engine lifecycle.
  - `dstns_property_invariants`: Boundary and invariant validations.
  - `dstns_replay_reproducibility`: Cross-compilation golden seed hashing.
  - `dstns_performance_smoke`: Micro-performance throughput assertions.
  - `api_smoke.py`: 15/15 end-to-end HTTP API lifecycle assertions.
  - `sumo_smoke.sh`: SUMO `netconvert` and headless microscopic physics validation.
  - `vitest`: UI Engine API decoding and overlay client validation.
- **UI Engine (`ui-engine`)**:
  - React 19 + TypeScript + MapLibre GL JS client for canonical road map rendering.
  - Independent Node.js Fastify server for UI Overlay API (`/ui-api/v1/*`).
- **Container Deployment**:
  - Multi-stage Dockerfiles and `docker-compose.yml` with Caddy TLS gateway.
