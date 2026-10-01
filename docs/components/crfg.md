# CRFG: Connected Radial Frontier Growth

Source: `OsmRoadLoader::load_xml` (`src/osm.cpp`).

CRFG cuts a connected district of real streets out of a city extract by
growing outward from a root along road distance, the way a district looks on
the ground, rather than cutting a rectangle through blocks.

## Algorithm

1. **Adjacency.** Build an undirected adjacency from every eligible road
   segment whose two nodes are both present.
2. **Candidates.** Nodes with at least two neighbours are candidates (all
   referenced nodes if none are).
3. **Root.**
    - *Seed-selected city* (`map.osm_file: auto`): the candidate nearest the
      seed's anchor, ties broken by OSM ID. One attempt.
    - *Pinned map or fixture*: the seed picks one of nine sectors of the map
      (north, north-east, east, … centre), then a candidate in it; up to 16
      seed-addressed roots are tried and the largest district kept.
4. **Growth.** Dijkstra from the root over segment lengths in the root's local equirectangular metres (accurate to well under 1% across a district);
   nodes are finalised in order of road distance, ties by OSM ID,
   until `target_nodes` are selected.

\[
\text{target} = \min\big(\texttt{max\_nodes},\; \max(\text{share}, 200),\; \texttt{district\_nodes}\big),
\qquad
\text{share} = \begin{cases} \lfloor 0.6 \cdot |V_{\text{ref}}| \rfloor & |V_{\text{ref}}| > 250 \\ |V_{\text{ref}}| & \text{otherwise} \end{cases}
\]

With the defaults (`district_nodes` 3,000, `max_nodes` 50,000) a city extract
yields a 3,000-node district. The share only binds for small sources, where
taking all of them would make every seed produce the same map.

## Properties

- **Connected** as an undirected graph. One-way restrictions can still make
  the directed graph not strongly connected; synthetic reverse edges keep it
  drawable.
- **Deterministic** for the same bytes, seed and configuration.
- **Compact**: Dijkstra order fills the nearest streets first.

Fewer than two selected nodes is an error (`OSM has no usable connected
region`). See [OSM map generation](../concepts/osm-map-generation.md#growing-the-district-crfg).
