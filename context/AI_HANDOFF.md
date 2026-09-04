# AI Handoff Document

## What is DSTNS?
DSTNS (Deterministic Spatiotemporal Transport Network Simulator) is a high-performance C++20 transport simulation platform that compiles reproducible road network scenarios from seeds and OpenStreetMap, executes spatiotemporal traffic and weather dynamics, integrates with Eclipse SUMO, and exposes a real-time REST/SSE control plane and React 19 + MapLibre GL UI.

## What has already been done?
1. **C++20 Core Library**: Philox deterministic RNG hierarchy, OSM road network extraction, CRFG radial frontier growth, DRNCP canonicalization, GraphStore, A* routing, Webster traffic signals, bus-stop placement, synthetic buildings, DWS weather storms, flood reservoir dynamics, and single-writer SimulationEngine with checkpoints and undo/redo.
2. **Dedicated CLI Tools**: `dstns_scenario_export`, `dstns_road_index`, `dstns_replay_verify`, `dstns_benchmark`.
3. **Automated Test Suite**: 4 C++ CTest targets, Python API lifecycle smoke (15 assertions), SUMO integration test (`netconvert` + `sumo`), and Vitest UI suite.
4. **UI & Overlay API**: React 19 + TypeScript + MapLibre GL JS web app with Fastify UI Overlay API (`/ui-api/v1/*`).
5. **Production Docker Stack**: Multi-stage C++ engine, Node UI container, and Caddy HTTPS reverse proxy.
6. **Documentation**: Full component documentation (`docs/components/`), API references (`docs/api/`), architecture/math guides, and OpenAPI 3.1 specification.

## Verification Commands
```bash
./scripts/build.sh
./scripts/test.sh
./tests/integration/sumo_smoke.sh
./build/dstns_replay_verify
./build/dstns_benchmark
```

## Critical Invariants — Do Not Break
- Keep Philox counter-based RNG isolation across all 8 domains.
- Ensure all physical road segments maintain reciprocal reverse twin directed edges.
- Only the single simulation engine thread mutates authoritative state; API threads submit commands.
- Ensure normalized parameters remain strictly bounded in $[0, 1]$.
