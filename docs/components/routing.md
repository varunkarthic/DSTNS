# Route Planning (`dstns::RoutePlanner`)

## Purpose
The `RoutePlanner` owns strategic, deterministic shortest-path and minimum-cost route calculation across the canonical road network using A* search.

## Responsibilities
- Compute optimal paths between origin and destination nodes `(from_node, to_node)`.
- Use dynamic travel-time edge cost, as integer milliseconds so summation order cannot change a route:
  $$\text{cost}(e) = \operatorname{round}\left(1000 \cdot \frac{\text{length\_m}(e)}{\max(0.1,\ \text{effective\_speed\_mps}(e))}\right)$$
- Respect manual road closures (`closed == true` treated as infinite traversal cost).
- Respect source-map directionality (`synthetic_reverse == true` is topology-only and never traversable).
- Break priority queue ties deterministically using lowest `NodeId`.
- Adhere to Euclidean distance / maximum speed heuristic to maintain admissibility.

## Public Interfaces
```cpp
struct RouteResult {
    bool found{false};
    std::uint64_t cost_ms{0};
    std::vector<EdgeId> edges;
};

class RoutePlanner {
public:
    explicit RoutePlanner(const GraphStore& graph);
    [[nodiscard]] RouteResult route(NodeId from, NodeId to) const;
};
```

See [Routing](../concepts/routing.md) for the heuristic's admissibility bound and where routes are used.
