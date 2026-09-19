# File Map (07)

```text
include/dstns/
  rng.hpp           - Seed128, Philox deterministic counter RNG, SHA-256
  model.hpp         - StrongId, NodeStatic/Dynamic, EdgeStatic/Dynamic, DwsEvent, Scenario
  graph.hpp         - GraphStore, RoutePlanner (A* shortest path)
  asb.hpp           - Adaptive Simulation Backpressure: score, ladder, governance
  geo.hpp           - City catalog, MapLocation, seed -> city+anchor selection, MapFetchError
  osm_fetch.hpp     - acquire_map_tile: seed-keyed tile cache and on-demand download
  osm.hpp           - OsmRoadLoader, OsmRoadGraph
  scenario.hpp      - ScenarioCompiler (CRFG, DRNCP, stops, buildings, signals, DWS, trips)
  engine.hpp        - SimulationEngine, Checkpoints, Playback Lifecycle, Overlays
  events.hpp        - EventRuntime min-heap scheduler, CongestionTracker
  logging.hpp       - RuntimeLogger (SQLite WAL, system.log)
  api.hpp           - ApiServer (cpp-httplib, REST, SSE stream)

src/
  rng.cpp, graph.cpp, asb.cpp, geo.cpp, osm.cpp, osm_fetch.cpp, scenario.cpp,
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
  preflight.mjs     - Startup verification: 12 checks including both test suites
  seeds.py          - SQLite saved-configuration store
  artifacts.mjs     - Run artifact helpers

ui-engine/src/      - React 19 observer; canvas map, no MapLibre
  App.tsx           - Shell: header, map layer, docks, deck, dialogs, overlays
  uiConfig.ts       - Configuration resolution (built-in / operator / viewer)
  useBackpressure.ts- Observer half of ASB; measurement and response validation
  MapDock.tsx       - Zoom, fit, search, auto-focus, DND, reduced motion
  Dialogs.tsx       - About, confirmations, auto-focus offer, ASB suspension
  Splash.tsx        - Boot screen driven by real core stages
  Logo.tsx          - The DSTNS mark, animatable
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
  appShell.test.tsx     - Shell behaviour, dialogs, ASB states; asserts presentation never reaches the core
  uiConfig.test.ts      - Configuration merge, validation, delta overrides
  api.test.ts           - REST client contract
  mapProjection.test.ts - Projection, metre scale, scale bar
  browser.mjs           - Live Chrome end-to-end against a real server
  large-browser.mjs     - Performance probe; attach to a paused large run
  container-browser.mjs - Attach to a Docker Compose run

tests/
  unit/test_main.cpp            - Core invariants
  unit/modernization_tests.cpp  - Events, signals, congestion, OSM loading
  unit/map_sourcing_tests.cpp   - Seed->city, extract cache, fetch failure, true scale
  unit/asb_tests.cpp            - Backpressure score, ladder, recovery, governance
  property/, replay/, performance/, integration/
  api/api_smoke.py              - End-to-end REST suite
  cli/                          - Seed store, artifacts, launcher integration

config/
  defaults.json     - Simulation defaults
  ui-config.json    - Observer presentation defaults

LICENSE             - GNU AGPL v3 (canonical FSF text)
COPYRIGHT           - Notice, AGPL section 13, third-party data terms

Dockerfile          - DEPRECATED; see docs/DOCKER.md
docker-compose.yml  - DEPRECATED
```
