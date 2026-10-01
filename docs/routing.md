# Routing

`RoutePlanner` (`include/dstns/graph.hpp`, `src/graph.cpp`) is the single
shortest-path authority in DSTNS. The scenario compiler uses it to plan trips
and to place bus stops, and the SUMO export uses the planned trips. There is
no public routing endpoint: the former browser Transit dispatcher is retired,
and `POST /api/v1/control/transit/route` returns HTTP 410
`TRANSIT_API_RETIRED`.

## Algorithm

A* search over directed edges:

| Element | Definition |
|---|---|
| Edge cost | `round(length_m / max(0.1, effective_speed_mps) × 1000)`, travel time in milliseconds as an integer |
| Heuristic | straight-line distance / 33.33 m/s (120 km/h), in the same units |
| Excluded edges | `synthetic_reverse` edges (against a one-way restriction) and edges currently closed |
| Tie-breaking | lower `f`, then lower `g`, then lower node ID |

Integer costs and explicit tie-breaking make the result independent of
floating-point summation order and of heap implementation details, so the same
graph and state always give the same route.

The heuristic is admissible as long as no edge is faster than 33.33 m/s. Free
speeds top out at 30 m/s for motorways; an operator speed multiplier above
about 1.1 on a motorway exceeds the bound, and routes found during such an
override may be slightly longer than optimal, though always valid.

## Result

```cpp
struct RouteResult { bool found; std::uint64_t cost; std::vector<EdgeId> edges; };
```

`found` is false when either endpoint is unknown or the destination cannot be
reached legally. A route from a node to itself is found, with cost 0 and no
edges.

## Where routes are used

| Consumer | Use |
|---|---|
| `ScenarioCompiler` trips | Planned trips across the district, all on legal directions |
| Bus-stop coverage | Graph distance between candidate stops |
| SUMO export | `sandbox.rou.xml` routes |
| Tests | `dstns_tests` (one-way detours), `dstns_prop_tests` (sampled all-pairs reachability excluding closed and forbidden edges), `dstns_perf_tests` (2,500 queries) |

## Performance

On a 15 × 15 grid, 2,500 queries take a few microseconds each on a laptop. The
performance smoke test fails if the mean exceeds 500 µs, a deliberately loose
bound that catches algorithmic regressions without being flaky on shared
runners. See [Performance](PERFORMANCE.md).
