# Bus-stop placement (`dstns::ScenarioCompiler::place_bus_stops`)

## Purpose
Deterministically places public transport bus stops along road segments using minimum-spacing and maximum-coverage rules.

## Algorithm & Constraints
1. **Starting Point**: Candidates are ordered deterministically by BFS shell from the scenario root, then by descending degree and ascending `NodeId`; placement does not use the RNG.
2. **Spacing Constraint**: Candidate anchors must be separated by at least `stop_min_spacing_m` road-network distance.
3. **Graph Distance Awareness**: Candidate stop nodes must be at least $d_{\text{min}}$ road-network distance from all previously placed bus stops.
4. **Edge Materialization**: Bus stops are anchored to specific directed edges with an explicit along-edge offset `position_m` $\in [0, \text{length\_m}]$.
5. **Coverage**: A deterministic repair pass adds the farthest eligible node until no eligible node exceeds `stop_max_coverage_m`.

## Data structure
```cpp
struct BusStop {
    StopId id;
    NodeId anchor_node;
    EdgeId edge;
    double position_m{};
    double nearest_stop_distance_m{};
};
```
