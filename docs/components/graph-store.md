# Graph storage (`dstns::GraphStore`)

## Purpose
The `GraphStore` represents the canonical topological and dynamical state of the road network $G(t) = (V, E, \mathbf{X}_V(t), \mathbf{X}_E(t))$. It enforces a strict separation between immutable static road geometry and mutable dynamic runtime state.

## Responsibilities
- Store static node attributes: coordinates $(x, y, \text{lat}, \text{lon})$, OSM node IDs, degree, bus stop flags, traffic signals, synthetic building associations, and $T_{\text{max}}$ temporal profiles.
- Store static edge attributes: directed endpoints $(\text{from}, \text{to})$, reverse twin edge ID, length in meters, road class, lanes, free-flow speed, base capacity, and polyline geometry.
- Store and update contiguous dynamic vectors: speeds, densities, vehicle counts, congestion levels, rainfall rates, flood depths, effective capacities, and closure flags.
- Maintain stable, 0-indexed strong identifier mappings (`NodeId`, `EdgeId`).
- Provide fast indexed lookups and outgoing edge adjacency traversals.

## Non-responsibilities
- Deciding routing policies (delegated to `RoutePlanner`).
- Modifying static graph topology during simulation runtime.

## Data structures
```cpp
struct NodeStatic {
    NodeId id;
    std::int64_t osm_node_id{};
    Point position;
    std::uint16_t degree{};
    bool bus_stop{}, signal{};
    std::optional<BuildingType> building;
    double building_impact{}, building_radius_m{}, flood_susceptibility{}, drainage{};
    std::vector<TimeWindow> tmax;
};

struct EdgeStatic {
    EdgeId id;
    NodeId from, to;
    EdgeId reverse_twin;
    std::int64_t osm_way_id{};
    std::uint32_t segment_index{};
    RoadClass road_class{RoadClass::Residential};
    bool source_oneway{}, synthetic_reverse{};
    std::uint16_t lanes{1};
    double length_m{}, free_speed_mps{}, base_capacity_vph{}, hotspot_susceptibility{}, flood_susceptibility{};
    std::vector<Point> geometry;
};
```

## Reverse twin invariant
In DSTNS, all physical road segments are modeled as pairs of opposing directed edges. Every edge $e = (u \to v)$ has a unique reciprocal reverse twin $e' = (v \to u)$ such that:
$$e.\text{reverse\_twin} = e'.\text{id} \quad \text{and} \quad e'.\text{reverse\_twin} = e.\text{id}$$

## Public interfaces
```cpp
class GraphStore {
public:
    explicit GraphStore(Scenario scenario);
    [[nodiscard]] const Scenario& scenario() const;
    [[nodiscard]] std::span<const NodeStatic> nodes() const;
    [[nodiscard]] std::span<const EdgeStatic> edges() const;
    [[nodiscard]] const NodeStatic& node(NodeId id) const;
    [[nodiscard]] const EdgeStatic& edge(EdgeId id) const;
    [[nodiscard]] NodeDynamic& node_state(NodeId id);
    [[nodiscard]] EdgeDynamic& edge_state(EdgeId id);
    [[nodiscard]] std::span<const EdgeId> outgoing(NodeId id) const;
    void commit();
    void reset_dynamic();
};
```

## Threading & Concurrency
- `GraphStore` has no lock of its own. Every access, from the engine loop or an
  API handler, happens under `SimulationEngine`'s mutex, so a reader always sees
  one consistent instant.
- Physics writes the dynamic arrays and then calls `commit()`, which bumps
  `state_revision`. Operator controls (edge overrides) write under the same
  mutex.
- The static scenario never changes during a run; a new world installs a new
  `GraphStore`.
