# Component Documentation Map

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
