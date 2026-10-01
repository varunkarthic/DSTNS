# Spatial queries

There is no spatial-index class. DSTNS uses free functions over projected
metres and bounded scans, which are fast enough for districts of a few
thousand nodes.

## Functions

| Function | Source | Computes |
|---|---|---|
| `point_distance(a, b)` | `src/graph.cpp` | Euclidean distance in projected metres \( (x_m, y_m) \), not great-circle |
| `wendland_c2(d, r)` | `src/graph.cpp` | The compact kernel \( (1-q)^4(1+4q) \), \( q = d/r < 1 \) |
| `temporal_beta(p, window)` | `src/graph.cpp` | A smooth Beta-shaped activity window with peak 1, for node-level building schedules |

The kernel is exactly 0 at and beyond its radius and has continuous first and
second derivatives, so nothing has a hard edge.

## Where spatial work happens

| Work | Approach | Cost |
|---|---|---|
| Rain at each node | Every node against every active storm | O(nodes × storms) per second |
| Surge coverage | Every edge's endpoints against every active surge | O(edges × surges) per second |
| Signal snapping | Junctions bucketed into 45 m cells; a tagged node checks its 3 × 3 cells | Linear in tagged nodes |
| Place → edges coupling | Precomputed once per run, Wendland weights within 400 m | One-time |
| Place → peers | Precomputed, capped at the 24 strongest neighbours | Bounded per tick |
| Place anchoring, stop corridors | Linear scans at load time | O(places × nodes) once |

An R-tree would make the load-time scans faster for very large extracts. It is
not needed at the default district size.
