# Deterministic Road-Network Canonicalization Pipeline (DRNCP)

## Purpose
DRNCP establishes deterministic, contiguous, 0-indexed canonical identifiers (`NodeId`, `EdgeId`) for selected nodes and directed edges from the same parsed input, configuration, and seed.

## Responsibilities
- Sort selected road nodes by ascending OSM node ID.
- Assign contiguous 0-indexed `NodeId(0 ... N-1)`.
- Traverse eligible ways in input XML order and their segments in `<nd>` order, emitting the source direction and then its reverse twin for each segment.
- Assign contiguous 0-indexed `EdgeId` values in that emission order. Edge IDs are not grouped or sorted by endpoint.
- Link reciprocal reverse twin edges and compute the invariant `graph_hash` = $\text{SHA-256}(V_{\text{canonical}} \parallel E_{\text{canonical}})$.

## Invariants
1. **Deterministic Input Replay**: Identical OSM bytes, configuration, and seed produce the same canonical IDs and `graph_hash` in the supported implementation.
2. **Container Independence**: Ordered maps/sets and explicit node sorting prevent hash-map traversal order from influencing IDs. Edge IDs intentionally retain OSM way/segment input order.
3. **Twin Reciprocity**: `edges[edges[i].reverse_twin].reverse_twin == i`.

`map_hash` separately hashes the complete OSM byte stream. Consumers must not infer spatial sweep order or endpoint grouping from canonical IDs.
