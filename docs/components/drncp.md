# DRNCP: deterministic canonical numbering

Source: `OsmRoadLoader::load_xml` and `ScenarioCompiler::calculate_hashes`.

DRNCP gives the selected district contiguous, 0-indexed IDs that depend only on
the input bytes, the seed and the configuration, never on container iteration
order.

## Rules

1. **Nodes.** The selected OSM nodes are sorted by OSM node ID and numbered
   `0 … N−1`.
2. **Ways.** Eligible road ways are sorted by OSM way ID.
3. **Edges.** For each way in that order, for each consecutive node pair in
   `<nd>` order with both nodes selected (and not equal), two edges are
   emitted: the forward direction, then its reverse. IDs are assigned in
   emission order, so `reverse_twin` of edge \( 2k \) is \( 2k+1 \) and vice
   versa.
4. **Segments.** Each pair gets a `segment_index` in emission order.
5. **Places.** Features are sorted by their ID string (`way/…`, `node/…`).

## Invariants

| Invariant | Statement |
|---|---|
| Twin reciprocity | `edges[edges[i].reverse_twin].reverse_twin == i` |
| Contiguity | Node IDs are `0 … N−1`, edge IDs `0 … 2M−1` |
| Determinism | Same bytes, seed and configuration give the same IDs and `graph_hash` |
| Direction | For a one-way way, the forward edge follows legal travel (`oneway=-1` ways are reversed first); the other is `synthetic_reverse` |

Consumers must not infer geometry from IDs: neighbouring IDs are not
neighbouring places.

## Hashes

`graph_hash` is a SHA-256 over the canonical node and edge records;
`map_hash` separately hashes the complete input byte stream. See
[Reproducibility](../concepts/reproducibility.md#the-hashes).
