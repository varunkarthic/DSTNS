# OpenStreetMap (OSM) Ingestion & Synthetic Map Generation

DSTNS compiles realistic, navigable road networks from either real-world OpenStreetMap (OSM) XML data or canonical synthetic metropolitan grids.

---

## 1. Geographic Diversity & Metropolitan Catalog

To ensure that small master seed changes produce completely distinct metropolitan landscapes rather than micro-shifted neighborhoods in a single city, `ScenarioCompiler` uses the derived `map_seed` to select across a worldwide catalog of 16 major metropolitan transport networks:

| Index | City | Base Coordinates (Lat, Lon) | Network Characteristics |
|---|---|---|---|
| 0 | Tokyo | 35.6895, 139.6917 | Dense multi-tier arterial grid |
| 1 | London | 51.5074, -0.1278 | Radial-concentric historic layout |
| 2 | New York | 40.7128, -74.0060 | Orthogonal grid & bridge corridors |
| 3 | Paris | 48.8566, 2.3522 | Boulevards and circular rings |
| 4 | Berlin | 52.5200, 13.4050 | Polycentric arterial arteries |
| 5 | Singapore | 1.3521, 103.8198 | Coastal expressways & transit corridors |
| 6 | Sydney | -33.8688, 151.2093 | Harbor-bounded radial branches |
| 7 | Toronto | 43.6532, -79.3832 | Great Lakes orthogonal grid |
| 8 | Mumbai | 19.0760, 72.8777 | Linear north-south coastal spines |
| 9 | Seoul | 37.5665, 126.9780 | Mountain-valley river crossings |
| 10 | São Paulo | -23.5505, -46.6333 | Dense radial ring expressways |
| 11 | Cairo | 30.0444, 31.2357 | Nile corridor arterial branches |
| 12 | San Francisco | 37.7749, -122.4194 | Peninsula grid with steep grades |
| 13 | Amsterdam | 52.3676, 4.9041 | Concentric canal ring bypasses |
| 14 | Stockholm | 59.3293, 18.0686 | Archipelago bridges & causeways |
| 15 | Dubai | 25.2048, 55.2708 | Linear coastal super-arterials |

### Deterministic City Selection
$$C_{\text{index}} = \text{map\_rng.uniform\_u64}() \pmod{16}$$
A single-bit flip in the master seed cascades through SHA-256 bit diffusion, completely changing $C_{\text{index}}$ and generating a completely different city environment.

---

## 2. Connected Radial Frontier Growth (CRFG)

When ingesting large raw OSM networks, the network can contain disconnected footpaths, service alleys, or isolated islands. CRFG deterministically extracts a single, strongly connected component of desired size (`max_nodes`):

1. **Anchor Selection**: Identifies high-centrality intersections near the geographic center.
2. **Priority Frontier Expansion**: Expands outward along driveable vehicle ways (excluding `footway`, `cycleway`, `path`, and private ways).
3. **Graph Integrity**: Continues until reaching target node count (typically 10,000 to 50,000 nodes for large-scale simulations).

---

## 3. Canonical Indexing (DRNCP)

Nodes and edges from raw OSM files have arbitrary 64-bit OSM IDs that vary between data dumps. The **Deterministic Road-Network Canonicalization Pipeline (DRNCP)** assigns contiguous 0-indexed integers:
1. Sort nodes by spatial coordinates: $(\text{round}(\text{lat}, 6), \text{round}(\text{lon}, 6))$.
2. Assign $u \in [0, |V| - 1]$.
3. Sort directed edges lexicographically by $(u, v, \text{road\_class})$.
4. Assign $e \in [0, |E| - 1]$.

This ensures that the resulting graph adjacency and memory layouts are identical across different machines, operating systems, and compilation flags.

---

## 4. OSM Caching & Offline Reliability

- Cached OSM downloads are keyed by their SHA-256 content digest.
- If network access to the Overpass API is unavailable or times out, DSTNS falls back deterministically to cached scenario fixtures or the canonical metropolitan catalog.
- Candidate regions are checked for minimum network size ($|V| \ge 50$, $|E| \ge 100$) before being committed.
