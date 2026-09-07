# Connected Radial Frontier Growth (CRFG)

## Purpose
CRFG extracts a topologically connected, well-shaped road network subgraph bounded by `max_nodes` starting from a deterministic seed-selected road anchor node.

## Responsibilities
- Partition eligible anchors into one of nine seed-selected geographic sectors and select a root using `RngDomain::MapSelection`.
- Expand outward radially along connected road edges using a priority queue ordered by network distance.
- Return the connected undirected frontier reached from that root; source one-way restrictions may mean the directed routing graph is not strongly connected.
- For source extracts above 250 referenced nodes, derive a seed-specific target of 180–699 nodes, capped by the source size and `max_nodes`; otherwise use the cap directly.

## Algorithm Details
1. **Candidate Anchor Selection**: Referenced road nodes with undirected adjacency degree $\ge 2$ are eligible (or all referenced nodes as fallback). A seed selects a geographic sector and then an anchor within its candidate pool.
2. **Radial Exploration**: A Dijkstra expansion explores adjacent road segments, tracking cumulative metric road distance from root $r$.
3. **Retry Rule**: Up to 16 seed-addressed roots are tried when a component yields fewer than `min(target_nodes, 25)` nodes.
4. **Seed-Specific Size**: For a source with more than 250 referenced nodes and a cap above 250, $|V_{\text{target}}|=180+U_s(520)$ before applying source and configuration caps.
5. **Output**: Connected vertex set $V_{\text{sub}}$ and incident directed edges $E_{\text{sub}}$.
