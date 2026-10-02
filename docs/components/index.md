# Components

All C++ implementation types in this directory live directly in the `dstns` namespace. Names such as graph, scenario, engine, replay, and spatial describe concerns, not nested C++ namespaces or independently instantiated services.

The concrete owners are:

- `GraphStore` and `RoutePlanner` in `include/dstns/graph.hpp`
- `OsmRoadLoader` in `include/dstns/osm.hpp`
- `ScenarioCompiler` in `include/dstns/scenario.hpp`
- `SimulationEngine` in `include/dstns/engine.hpp`
- `RuntimeLogger` in `include/dstns/logging.hpp`
- `ApiServer` in `include/dstns/api.hpp`
- `SumoBridge` in `include/dstns/sumo_bridge.hpp`
- `DeterministicRng` and `Seed128` in `include/dstns/rng.hpp`

Several documents split behavior owned by one class into smaller conceptual topics. In particular, replay and checkpoint behavior are private `SimulationEngine` operations, while spatial work uses free kernel functions and linear scans rather than a spatial-index object.

| Page | Owner | Covers |
|---|---|---|
| [API server](api-server.md) | `ApiServer` | Routes, validation, guard, error mapping, concurrency |
| [Graph store](graph-store.md) | `GraphStore` | Static graph and the view of dynamic state |
| [Vulkan backend](vulkan-backend.md) | `src/vulkan/` | The physics step and field kernels on a GPU |
| [OSM loader](osm-loader.md) | `OsmRoadLoader` | Parsing, filtering, places |
| [CRFG](crfg.md) | `OsmRoadLoader` | District growth |
| [DRNCP](drncp.md) | `OsmRoadLoader`, `ScenarioCompiler` | Canonical numbering and hashes |
| [RNG](rng.md) | `DeterministicRng`, `Seed128` | Seeds, sub-seeds, counter-based draws |
| [Event engine](event-engine.md) | `EventRuntime`, `SimulationEngine` | Scheduled and operator events, undo |
| [Signals](signals.md) | `ScenarioCompiler`, `EventRuntime` | Placement, timing, green waves, overrides |
| [Traffic model](traffic-control.md) | `SimulationEngine` | The per-second traffic computation |
| [Bus stops](bus-stops.md) | `ScenarioCompiler` | Routable stop placement |
| [Buildings and places](buildings.md) | `demand.cpp`, `EventRuntime` | Place taxonomy and demand |
| [Weather (DWS)](dws.md) | `ScenarioCompiler`, `SimulationEngine` | Storm schedule and fields |
| [Flood model](flood-model.md) | `SimulationEngine` | Flood integration |
| [Routing](routing.md) | `RoutePlanner` | A* |
| [Playback engine](playback-engine.md) | `SimulationEngine` | Clock, loop, checkpoints |
| [Replay](replay-engine.md) | `SimulationEngine`, `ScenarioCompiler` | Determinism and verification |
| [Spatial queries](spatial-index.md) | free functions | Distances, kernels, scans |
| [Logging system](logging-system.md) | `RuntimeLogger` | Text log and SQLite journal |
| [SUMO adapter](sumo-adapter.md) | `SumoBridge` | Export and batch SUMO runs |
| [Observer](ui-engine.md) | `ui-engine/` | The browser application |
