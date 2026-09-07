# OSM Loader (`dstns::OsmRoadLoader`)

## Purpose
The OSM Loader ingests OpenStreetMap XML snapshots and extracts strictly drivable, motorized road networks. It discards non-road entities (e.g., buildings, landuse, administrative boundaries, pedestrian paths) and normalizes geometry into canonical DSTNS coordinates.

## Responsibilities
- Parse OSM `<node>` and `<way>` elements with valid `highway=*` vehicular tags.
- Filter out non-drivable highway types (e.g. `footway`, `path`, `cycleway`, `steps`, `pedestrian`).
- Materialize reverse twins for every physical segment while tracking `source_oneway` and `synthetic_reverse` provenance. Synthetic reverse twins preserve canonical topology and visualization, but are excluded from routing, demand, controls, bus-stop lanes, hotspots, and SUMO export.
- Project WGS84 geographic coordinates $(\text{lat}, \text{lon})$ to local metric coordinates $(x, y)$ in meters using equirectangular projection.
- Compute a stable SHA-256 source hash over the complete input XML byte stream.

## Highway Filtering Rules
Included vehicular highway types:
- `motorway`, `motorway_link`
- `trunk`, `trunk_link`
- `primary`, `primary_link`
- `secondary`, `secondary_link`
- `tertiary`, `tertiary_link`
- `residential`, `living_street`, `unclassified`
- `service`
- `track`

## Public Interfaces
```cpp
class OsmRoadLoader {
public:
    [[nodiscard]] OsmRoadGraph load_xml(
        const std::filesystem::path& file,
        std::uint32_t max_nodes,
        const DeterministicRng& rng
    ) const;
};
```
