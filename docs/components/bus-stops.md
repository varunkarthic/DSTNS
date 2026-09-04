# Bus-Stop Placement Subsystem (`dstns::scenario`)

## Purpose
Deterministically places public transport bus stops along road segments ensuring minimum spacing, maximum coverage, and uniform spatial distribution.

## Algorithm & Constraints
1. **Starting Point**: Anchor selection uses `RngDomain::BusStops`.
2. **Spacing Constraint**: Minimum metric spacing $d_{\text{min}} = 300\text{ m}$, target spacing $d_{\text{target}} = 500\text{ m}$.
3. **Graph Distance Awareness**: Candidate stop nodes must be at least $d_{\text{min}}$ road-network distance from all previously placed bus stops.
4. **Edge Materialization**: Bus stops are anchored to specific directed edges with an explicit along-edge offset `position_m` $\in [0, \text{length\_m}]$.
5. **Coverage**: Places stops iteratively until all connected corridors are within $d_{\text{max\_coverage}} = 800\text{ m}$ of a bus stop.

## Data Structure
```cpp
struct BusStop {
    StopId id;
    NodeId anchor_node;
    EdgeId edge;
    double position_m{};
    double nearest_stop_distance_m{};
};
```
