# Deterministic Road-Network Canonicalization Pipeline (DRNCP)

## Purpose
DRNCP establishes stable, reproducible, 0-indexed canonical identifiers (`NodeId`, `EdgeId`) for all nodes and directed edges across platforms, compilers, and memory layouts.

## Responsibilities
- Sort selected road nodes deterministically by spatial coordinates $(y, x)$ followed by OSM ID tie-breaking.
- Assign contiguous 0-indexed `NodeId(0 ... N-1)`.
- Sort directed edges by `(from_node_id, to_node_id, segment_index)`.
- Assign contiguous 0-indexed `EdgeId(0 ... 2M-1)`.
- Link reciprocal reverse twin edges and compute the invariant `graph_hash` = $\text{SHA-256}(V_{\text{canonical}} \parallel E_{\text{canonical}})$.

## Invariants
1. **Platform Independence**: Identical OSM input and seed produce identical `graph_hash` on macOS, Linux, and Windows.
2. **Order Independence**: Hash-map traversal orders in memory never influence assigned node/edge IDs.
3. **Twin Reciprocity**: `edges[edges[i].reverse_twin].reverse_twin == i`.
