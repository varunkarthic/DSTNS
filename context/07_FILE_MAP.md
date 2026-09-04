# File Map (07)

```text
include/dstns/
  rng.hpp           - Seed128, Philox deterministic counter RNG, SHA-256
  model.hpp         - StrongId, NodeStatic/Dynamic, EdgeStatic/Dynamic, DwsEvent, Scenario
  graph.hpp         - GraphStore, RoutePlanner (A* shortest path)
  osm.hpp           - OsmRoadLoader, OsmRoadGraph
  scenario.hpp      - ScenarioCompiler (CRFG, DRNCP, stops, buildings, signals, DWS, trips)
  engine.hpp        - SimulationEngine, Checkpoints, Playback Lifecycle, Overlays
  logging.hpp       - RuntimeLogger (SQLite WAL, system.log)
  api.hpp           - ApiServer (cpp-httplib, REST, SSE stream)

src/
  rng.cpp, graph.cpp, osm.cpp, scenario.cpp, engine.cpp, logging.cpp, api.cpp

apps/dstns_server/
  main.cpp          - C++ DSTNS API Server binary

tools/
  scenario-inspect/ - Scenario inspection and SUMO XML exporter
  road-index/       - OSM Road network loader and indexer
  replay-verify/    - Replay verification and seek matching tool
  benchmark/        - Compilation, routing, and snapshot micro-benchmarks

ui-engine/
  src/              - React 19 + MapLibre GL UI application
  server/           - Fastify UI Overlay API server
  tests/            - Vitest UI test suite

docker/
  Dockerfile        - Multi-stage C++ engine build
  docker-compose.yml- Orchestration for engine, ui, and gateway
  gateway/          - Caddy reverse proxy and TLS configuration
```
