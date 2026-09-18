# File Map (07)

```text
include/dstns/
  rng.hpp           - Seed128, Philox deterministic counter RNG, SHA-256
  model.hpp         - StrongId, NodeStatic/Dynamic, EdgeStatic/Dynamic, DwsEvent, Scenario
  graph.hpp         - GraphStore, RoutePlanner (A* shortest path)
  geo.hpp           - City catalog, MapLocation, seed -> city+anchor selection, MapFetchError
  osm_fetch.hpp     - acquire_map_tile: seed-keyed tile cache and on-demand download
  osm.hpp           - OsmRoadLoader, OsmRoadGraph
  scenario.hpp      - ScenarioCompiler (CRFG, DRNCP, stops, buildings, signals, DWS, trips)
  engine.hpp        - SimulationEngine, Checkpoints, Playback Lifecycle, Overlays
  events.hpp        - EventRuntime min-heap scheduler, CongestionTracker
  logging.hpp       - RuntimeLogger (SQLite WAL, system.log)
  api.hpp           - ApiServer (cpp-httplib, REST, SSE stream)

src/
  rng.cpp, graph.cpp, geo.cpp, osm.cpp, osm_fetch.cpp, scenario.cpp,
  engine.cpp, events.cpp, logging.cpp, api.cpp, sumo_bridge.cpp

apps/dstns_server/
  main.cpp          - C++ DSTNS API Server binary

scripts/
  fetch_osm.py      - Overpass importer; invoked by the core for on-demand tiles

tools/
  scenario-inspect/ - Scenario inspection and SUMO XML exporter
  road-index/       - OSM Road network loader and indexer
  replay-verify/    - Replay verification and seek matching tool
  benchmark/        - Compilation, routing, and snapshot micro-benchmarks

dstns-operator-cli/
  dstns.mjs         - Operator TUI and non-interactive launcher (start authority)
  seeds.py          - SQLite saved-configuration store
  artifacts.mjs     - Run artifact helpers

ui-engine/src/      - React 19 observer; canvas map, no MapLibre
  App.tsx           - Alpha shell: header, map layer, docks, deck, overlays
  theme.css         - Design tokens transcribed from ui-engine-alpha
  style.css         - Pre-existing component styles (map canvas, tooltips, report)
  NetworkMap.tsx    - Canvas renderer; MapControls handle, view/cursor callbacks
  TelemetryDeck.tsx - Metrics, congestion meter, Stack/News/Queue/Incidents tabs
  PlaybackDock.tsx  - Scrubber, clock, rate slider, transport controls
  LayersPopover.tsx - Display layers (frontend-only)
  Tooltip.tsx       - Shared delayed custom tooltip and InfoCard
  useSimulation.ts  - Polling client: status, snapshot, topology, news
  api.ts            - Typed REST client
  mapModel.ts       - Road state colours, inspection text, hit testing
  mapProjection.ts  - Equirectangular fit, metre<->degree, scale bar
  report.ts         - Local three-page PDF export
  types.ts          - API DTOs, Layers, defaultLayers

ui-engine/tests/
  appShell.test.tsx     - Shell behaviour; asserts layers never reach the core
  api.test.ts           - REST client contract
  mapProjection.test.ts - Projection, metre scale, scale bar
  browser.mjs           - Live Chrome end-to-end against a real server
  large-browser.mjs     - Performance probe; attach to a paused large run
  container-browser.mjs - Attach to a Docker Compose run

tests/
  unit/test_main.cpp            - Core invariants
  unit/modernization_tests.cpp  - Events, signals, congestion, OSM loading
  unit/map_sourcing_tests.cpp   - Seed->city, tile cache, fetch failure, true scale
  property/, replay/, performance/, integration/
  api/api_smoke.py              - End-to-end REST suite
  cli/                          - Seed store, artifacts, launcher integration

Dockerfile          - Multi-stage: UI build, C++ build, unified runtime
docker-compose.yml  - Single-service orchestration
```
