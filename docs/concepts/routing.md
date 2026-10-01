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

## Mathematics

### Cost and heuristic

Let a path be a sequence of legal, open edges \( e_1, \dots, e_n \). Its cost is the
sum of integer edge costs, in milliseconds:

\[
c(e) = \operatorname{round}\!\Big(1000\,\frac{L_e}{\max(0.1,\; v_e)}\Big),
\qquad
g(\text{path}) = \sum_{i=1}^{n} c(e_i)
\]

where \( v_e \) is the edge's *current* effective speed, so a route reflects live
congestion, weather and incidents. The planned trips that the compiler creates at
scenario time are computed on the initial state, where every edge is at free speed.

The heuristic is the straight-line travel time at the fastest speed any road is
assumed to allow, \( v_{\max} = 33.33 \) m/s:

\[
h(n) = \operatorname{round}\!\Big(1000\,\frac{\lVert p_n - p_t \rVert}{v_{\max}}\Big)
\]

with \( p_n \) the node's position and \( p_t \) the destination's. A* expands nodes in
order of \( f(n) = g(n) + h(n) \).

### Why it finds the optimum

A* returns a shortest path if \( h \) is **admissible**, never overestimating the
remaining cost. Any path from \( n \) to \( t \) is at least as long as the straight line,
and no edge is faster than \( v_{\max} \), so

\[
h^*(n) \;=\; \sum_i \frac{L_{e_i}}{v_{e_i}} \;\ge\; \sum_i \frac{L_{e_i}}{v_{\max}} \;\ge\; \frac{\lVert p_n - p_t \rVert}{v_{\max}} \;=\; h(n)
\]

The first inequality uses \( v_{e_i} \le v_{\max} \); the second is the triangle
inequality, since an edge's length is the straight-line distance between its
endpoints (a path's total length cannot be less than the direct distance). The
heuristic is also **consistent**: for an edge \( (a, b) \),

\[
h(a) \;\le\; c(a,b) + h(b)
\]

because \( \lVert p_a - p_t \rVert - \lVert p_b - p_t \rVert \le \lVert p_a - p_b \rVert = L_{(a,b)} \)
(the triangle inequality again) and \( c(a,b) \ge 1000\,L/v_{\max} \). Consistency
means a node is settled the first time it is popped, so none is expanded twice, and
the work is at most that of Dijkstra's algorithm:

\[
T = O\big((V + E)\log V\big)
\]

with the heuristic usually cutting the explored region sharply.

The bound holds to within rounding (a fraction of a millisecond per edge). It fails
only if some edge exceeds \( v_{\max} \): free speeds reach 30 m/s on motorways, so an
operator speed multiplier above \( 33.33 / 30 \approx 1.11 \) on a motorway breaks
admissibility, and the route found may then be slightly longer than the true optimum,
though always valid.

### Worked example

A residential-class edge of 1,200 m at 13.89 m/s costs

\[
c = \operatorname{round}\!\big(1000 \times 1200 / 13.89\big) = 86{,}393\ \text{ms}
\]

If the destination is 1,000 m away in a straight line, the heuristic at the start is
\( h = \operatorname{round}(1000 \times 1000 / 33.33) = 30{,}003 \) ms, well below the true
cost, so it never misleads the search. On a 30 m/s motorway the same 1 km costs
33,333 ms against a bound of 30,003 ms: still admissible, with the gap the rounding
margin of the speed assumption.

### Determinism

Priority is the triple \( (f, g, \text{node ID}) \), compared in that order, so two
nodes with equal \( f \) are ordered by \( g \) and then by ID, never by memory
address or insertion order:

```cpp
struct Q { std::uint64_t f, g; NodeId n; };
struct C {
    bool operator()(const Q& a, const Q& b) const {
        return a.f != b.f ? a.f > b.f : (a.g != b.g ? a.g > b.g : a.n.value > b.n.value);
    }
};
// ...
if (cur.g != cost[cur.n.value]) continue;     // a stale queue entry: skip it (lazy deletion)
```

Costs are integers, so the sum along a path does not depend on the order of
addition, and floating-point rounding cannot change which of two near-equal routes
wins. The `cur.g != cost[...]` test discards queue entries superseded by a cheaper
path found later (lazy deletion), which is cheaper than a decrease-key operation.

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
runners. See [Performance](../deployment/performance.md).
