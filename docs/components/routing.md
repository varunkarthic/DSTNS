# Route Planning Subsystem (`dstns::graph`)

## Purpose
The `RoutePlanner` owns strategic, deterministic shortest-path and minimum-cost route calculation across the canonical road network using A* search.

## Responsibilities
- Compute optimal paths between origin and destination nodes `(from_node, to_node)`.
- Use dynamic travel-time edge cost:
  $$\text{cost}(e) = \frac{\text{length\_m}(e)}{\text{effective\_speed\_mps}(e)}$$
- Respect manual road closures (`closed == true` treated as infinite traversal cost).
- Respect source-map directionality (`synthetic_reverse == true` is topology-only and never traversable).
- Break priority queue ties deterministically using lowest `NodeId`.
- Adhere to Euclidean distance / maximum speed heuristic to maintain admissibility.

## Public Interfaces
```cpp
struct RouteResult {
    bool found{false};
    double cost_ms{0.0};
    std::vector<EdgeId> edges;
};

class RoutePlanner {
public:
    explicit RoutePlanner(const GraphStore& graph);
    [[nodiscard]] RouteResult route(NodeId from, NodeId to) const;
};
```
