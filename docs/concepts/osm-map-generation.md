# OSM map generation

Every DSTNS world is cut from real OpenStreetMap data. This page follows a
seed from a number to a connected, true-scale road graph with its signals,
stops and places: choosing a city and a district, downloading and caching the
extract, parsing it, growing the district, and numbering it canonically.


## From seed to place

With `map.osm_file: "auto"`, `select_map_location` (`src/geo.cpp`) resolves
the seed under the `urban-crfg-v3` selection version:

1. **City.** A sub-seed derived as `seed.derive("map.city")` picks one of 181
   urban centres across every inhabited continent. The catalogue and its order
   are part of the version, so seeds saved under an older version are refused
   rather than silently landing somewhere else.
2. **Extract.** The city's extract is a square of `city_extent_m` (default
   5 km) centred on the city. Its bounds depend only on the city and the
   extent, so every district of one city shares one download.
3. **Anchor.** A second sub-seed, `seed.derive("map.anchor")`, picks a point
   in the middle half of the extract (inset by a quarter on each side), so a
   district grown around it stays inside the downloaded area.

Different seeds that land on the same city therefore produce different
districts from the same file, with no further download.

## Downloading and caching

The extract is cached at `<cache_dir>/<city-slug>_x<extent>.osm.xml`, for
example `data/maps/cologne_x5000.osm.xml`. A cached file of at least 4 KiB is
used as is; a smaller one is treated as truncated, deleted and fetched again.

On a miss, the server runs `python3 scripts/fetch_osm.py --bbox S,W,N,E
--output FILE` in its own process group (see [Security](../deployment/security.md#external-processes)).
The script:

- queries Overpass for `highway`, `building`, `landuse` and `leisure` ways,
  traffic-signal nodes, and the nodes they reference, in XML;
- tries each endpoint in `DSTNS_OVERPASS_ENDPOINTS`, or four public mirrors,
  with retries and exponential back-off;
- reads the response, publishing `connect`, `download`, `parse` and byte
  counts to a `.progress` sidecar that `/api/v1/system/map-status` and the
  observer read;
- checks that it is an `<osm>` document with at least one way and no Overpass
  error remark;
- writes it through a temporary `.part` sibling and renames it into place, so
  no reader sees a partial file;
- writes a provenance manifest (`<city-slug>_x<extent>.osm.manifest.json`:
  endpoint, bounding box, time, SHA-256, size, query) and removes the sidecar.

A failure is reported as `MAP_FETCH_FAILED` naming the city, the anchor and the
cause. No substitute map is used: that would break the correspondence between
a seed and the place it names. The server's start-up sweep removes `.part` and
`.progress` files left by downloads that were killed, and prunes old extracts
according to `--map-cache` (see [Configuration](../guide/configuration.md#server-flags)).

## Parsing

`OsmRoadLoader::load_xml` (`src/osm.cpp`) is a single-pass tokenizer over
`<node>` and `<way>` elements. Attribute values are UTF-8-repaired and capped
at 512 bytes, and XML entities are decoded. Coordinates must be finite and
within ±90 and ±180 degrees, or the map is refused.

### Which ways are roads

A way becomes road only if all of these hold:

- `highway` is one of `motorway`, `motorway_link`, `trunk`, `trunk_link`,
  `primary(_link)`, `secondary(_link)`, `tertiary(_link)`, `unclassified`,
  `residential`, `living_street`, `service` or `track`;
- `access` is neither `private` nor `no`;
- it references at least two nodes present in the file.

| Road class | From `highway` | Free speed | Capacity (veh/h) | Lanes |
|---|---|---|---|---|
| Motorway | motorway, trunk and their links | 30.00 m/s (108 km/h) | 4800 | 3 |
| Primary | primary(_link) | 16.67 m/s (60 km/h) | 3200 | 2 |
| Secondary | secondary(_link) | 13.89 m/s (50 km/h) | 2400 | 1 |
| Tertiary | tertiary(_link) | 11.11 m/s (40 km/h) | 1800 | 1 |
| Residential | residential, unclassified | 8.33 m/s (30 km/h) | 1100 | 1 |
| Service | service, track, living_street | 5.56 m/s (20 km/h) | 600 | 1 |

### Direction

| Tags | Treated as |
|---|---|
| `oneway=yes`, `1` or `true` | One-way in drawing order |
| `oneway=-1` | One-way against drawing order (node order is reversed) |
| `junction=roundabout` with no `oneway` tag | One-way, as OSM convention requires |
| anything else | Two-way |

Every road segment produces two directed edges. For a one-way road the
reverse edge is kept for topology, so the graph stays strongly connected for
display and indexing, but is marked `synthetic_reverse`. It carries no demand,
routing never uses it, and SUMO export omits it.

### Node roles

| Tag | Role |
|---|---|
| `highway=bus_stop` or `platform`, `amenity=bus_station` | Bus stop candidate |
| `highway=traffic_signals` | Signal candidate, snapped to the nearest junction (below) |
| `amenity=school`, `university`, `college`, `kindergarten` | School demand |
| `office=*`, `amenity=bank`, `courthouse`, `townhall` | Office demand |
| `shop=mall`, `amenity=marketplace` | Mall demand |
| any other `shop=*`, `amenity=restaurant`, `cafe`, `fast_food`, `pharmacy` | Store demand |

OSM rarely tags the junction node itself as `traffic_signals`; it tags the
stop line a few metres back along one approach. The scenario compiler snaps
each tagged node to the nearest junction of degree 3 or more within 45 m, so several approaches collapse into the one controller that governs
the junction, and a tagged node with no junction nearby (a pedestrian
crossing) is dropped.

### Places

Ways tagged `building`, `amenity`, `shop`, `office`, `leisure`, `landuse`,
`railway` or `public_transport`, and nodes tagged `amenity`, `shop`, `office`,
`leisure`, `railway` or `public_transport` or acting as stops, become places
(`MapFeature`). A closed way of more than three nodes is a polygon. Each place
gets a centre, a category (the most specific of its tags), a demand type, and
an anchor node (the nearest road node). Places whose centre falls outside the
district's bounding box are dropped. The demand model then classifies places
into the taxonomy served at `/api/v1/view/place-kinds`; see
[API: places](../api/reference.md#places).

## Growing the district (CRFG)

Connected Radial Frontier Growth builds a connected district around the anchor:

1. Collect road nodes with at least two neighbours as anchor candidates.
2. Root the district at the candidate nearest the seed's anchor, ties broken by
   OSM ID. A bare fixture with no resolved location instead picks a seeded
   sector of the map and tries up to 16 roots, keeping the largest district.
3. Run Dijkstra outwards from the root over road distance, finalising nodes in
   order until `target_nodes` are selected, where

   ```
   target_nodes = min(max_nodes, max(share, 200), district_nodes)
   share        = 60% of available road nodes if there are more than 250, else all
   ```

The result is a connected district of real streets that grows outward evenly
from the anchor, rather than a rectangle cut through blocks.

### Mathematics of district growth

CRFG is Dijkstra's algorithm run from the root, stopped after \( n^\ast \) nodes are
settled:

\[
n^{\ast} = \min\big(\texttt{max\_nodes},\; \max(\sigma,\, 200),\; \texttt{district\_nodes}\big), \qquad
\sigma = \begin{cases} \lfloor 0.6\, V_{\text{ref}} \rfloor & V_{\text{ref}} > 250 \\ V_{\text{ref}} & \text{otherwise} \end{cases}
\]

where \( V_{\text{ref}} \) is the number of road nodes in the extract. The district is the
set of the \( n^\ast \) nodes with the smallest road-network distance \( d(\text{root}, v) \),
so it is the ball of radius \( \rho \) around the root in the road metric, with \( \rho \)
chosen to contain \( n^\ast \) nodes:

\[
D = \{\, v \;:\; d(\text{root}, v) \le \rho \,\}, \qquad |D| = n^{\ast}
\]

The loop, condensed from `src/osm.cpp`:

```cpp
while (!pq.empty() && selected.size() < target_nodes) {
    const auto top = pq.top();  pq.pop();
    if (finalized.contains(top.osm_id)) continue;           // stale queue entry
    finalized.insert(top.osm_id);  selected.push_back(top.osm_id);
    for (auto v : adjacency[top.osm_id]) {
        const double candidate = top.dist + segment_length(top.osm_id, v);
        if (!finalized.contains(v) && (known == distance.end() || candidate < known->second)) {
            distance[v] = candidate;  pq.push({candidate, v});
        }
    }
}
```

With a binary heap the cost is \( O\big((n^\ast + E_D)\log n^\ast\big) \) for the \( E_D \)
edges touched, so growing a 3,000-node district from a million-node extract does not
examine the rest of the city. Ties in distance are broken by OSM ID, so the same
extract and anchor always produce the same set.

### The nearest road node

The root is the candidate nearest the anchor \( (\varphi_a, \lambda_a) \), compared by
squared planar distance with the longitude scaled by \( \cos\varphi_a \):

\[
\Delta_y = \varphi - \varphi_a, \quad \Delta_x = (\lambda - \lambda_a)\cos\varphi_a, \quad
\text{root} = \arg\min_{v}\; \big(\Delta_x^2 + \Delta_y^2\big)
\]

Squared distance avoids a square root per candidate and orders candidates
identically. The anchor itself comes from the seed; see
[Deterministic seeding](deterministic-seeding.md#worked-example-seed-42).

## Canonical numbering and projection

Selected nodes are sorted by OSM ID and numbered from 0, so the same extract
and seed always give the same IDs (DRNCP: deterministic, canonical, 0-indexed).
Positions are projected with a local equirectangular projection centred on the
district's mean coordinate:

```
x_m = (lon − lon0) × 111320 × cos(lat0)
y_m = (lat − lat0) × 111320
```

These are true metres from the origin; the map sourcing suite checks them
against haversine ground truth to within 0.13%. Any visual compression is the
client's business and never feeds back into the model. See [Graph
model](graph-model.md).

### Mathematics of the projection

The projection is **local equirectangular** about the district's mean position
\( (\varphi_0, \lambda_0) \), with one fixed longitude scale:

\[
x = (\lambda - \lambda_0)\; m\cos\varphi_0, \qquad y = (\varphi - \varphi_0)\; m, \qquad m = 111{,}320\ \text{m/degree}
\]

```cpp
n.position.y_m = (r.lat - lat0) * 111320.0;
n.position.x_m = (r.lon - lon0) * 111320.0 * std::cos(lat0 * 3.141592653589793 / 180.0);
```

It is exact along the central meridian and parallel, and drifts away from them
because a degree of longitude shrinks with latitude as \( \cos\varphi \), while the
projection uses the constant \( \cos\varphi_0 \). To first order the relative error in
an east-west distance at latitude \( \varphi_0 + \Delta\varphi \) is

\[
\varepsilon \;\approx\; \tan\varphi_0\;\Delta\varphi
\]

For a district reaching 2.5 km north or south of its centre (\( \Delta\varphi = 2500/111320
= 0.0225^\circ = 3.9 \times 10^{-4} \) rad), this gives

| Latitude \( \varphi_0 \) | 0° | 30° | 52° | 60° |
|---|---|---|---|---|
| \( \varepsilon \) at 2.5 km | 0 | 0.023% | 0.050% | 0.068% |

The map sourcing suite compares modelled distances with haversine ground truth on the
bundled district and measures a worst-case error of **0.126%**
(`dstns_map_tests`), within the 1% budget it asserts. The error is a property of the
*picture*, not of the physics: lengths, speeds and capacities are all computed in the
same projected metres, so they are consistent with each other.

## Edges

Edges are emitted in way-ID order, segment by segment, as a forward and
reverse pair (`reverse_twin` links them). Each carries its OSM way ID, segment
index, road class, name and tags, length, free speed, capacity, lanes, the mean
flood susceptibility of its endpoints, and its geometry. Consecutive duplicate
node references are skipped. Node flood susceptibility and drainage are drawn
from the seed's weather-field domain.

## Bus stops

OSM records a stop per kerb, per platform and per operator, so one place on the
ground can arrive as several nodes metres apart. Stops are thinned against the
street each one serves: stops on the same corridor are held 300 m apart, while
stops on parallel streets need only clear 60 m. The best-attested member of a
cluster survives (named station, then named stop, then unnamed), ties broken by
place ID. The scenario compiler then places routable stops on traversable edges
for coverage. See [Bus stops](../components/bus-stops.md).

## Hashes

| Hash | Over |
|---|---|
| `map_hash` | SHA-256 of the complete input bytes |
| `graph_hash` | The canonical graph |
| `event_hash` | Scheduled weather and incidents |
| `scenario_hash` | All of the above with the resolved configuration |

Any change to the input bytes changes `map_hash` and so `scenario_hash`, even
when the selected district is identical. See
[Reproducibility](reproducibility.md).

## Pinned maps and fixtures

`--osm-file PATH` (or `map.osm_file`) pins a map. The seed then still chooses
the root within it, but not the city. Test fixtures in `tests/fixtures/` and
`data/fixtures/` are small hand-written or recorded extracts:

| Fixture | Used for |
|---|---|
| `tests/fixtures/roads.osm.xml` | Road filtering and one-way routing |
| `tests/fixtures/oneway_sink.osm.xml` | Stops never anchored where nothing can leave |
| `tests/fixtures/roundabout.osm.xml` | Untagged roundabouts as one-way; `shop=mall` nodes |
| `data/fixtures/real_network.osm.xml` | A recorded real district for seeded districts and the launcher test |

Synthetic grids (`fixture.grid_width`, `grid_height`) exist only for tests and
are never substituted for a failed download.
