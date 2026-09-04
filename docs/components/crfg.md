# Connected Radial Frontier Growth (CRFG)

## Purpose
CRFG extracts a topologically connected, well-shaped road network subgraph bounded by `max_nodes` starting from a deterministic seed-selected road anchor node.

## Responsibilities
- Select a root anchor node deterministically from candidate high-connectivity road junctions using `RngDomain::MapSelection`.
- Expand outward radially along connected road edges using a priority queue ordered by network distance.
- Ensure the extracted subgraph forms a single strongly connected component without orphaned islands.
- For large source extracts, derive a seed-specific 260–359-node district size; otherwise stop at the configured `max_nodes` limit.

## Algorithm Details
1. **Candidate Anchor Selection**: Road nodes with degree $\ge 3$ are indexed. A pseudo-random index is drawn from `RngDomain::MapSelection`.
2. **Radial Exploration**: A Dijkstra expansion explores adjacent road segments, tracking cumulative metric road distance from root $r$.
3. **Frontier Pruning**: Dead ends and disconnected components outside the active frontier are excluded.
4. **Seed-Specific Size**: For a source with more than 400 road nodes, $|V_{\text{sub}}|=260+U_s(100)$, where $U_s$ is a deterministic bounded draw in `RngDomain::MapSelection`.
5. **Output**: Connected vertex set $V_{\text{sub}}$ and incident directed edges $E_{\text{sub}}$.
