# Spatiotemporal Graph Model

The DSTNS graph representation (`GraphStore` in `include/dstns/graph.hpp`, `src/graph.cpp`) cleanly separates static geometric topology from high-frequency dynamic simulation vectors.

---

## 1. Contiguous 0-Indexed Entity Architecture

To maximize CPU cache spatial locality and enable $O(1)$ flat array lookups:
- `NodeId`: Dense integer $u \in [0, |V| - 1]$.
- `EdgeId`: Dense integer $e \in [0, |E| - 1]$.
- Static properties are stored in contiguous `std::vector` structures.
- Dynamic attributes are stored in separate parallel vectors modified each tick.

---

## 2. Static & Dynamic Data Structures

### Static Nodes (`NodeStatic`)
- Geographic coordinates: Latitude, Longitude, Elevation ($z$).
- Metric projected coordinates: UTM / local Mercator projection $(x, y)$ in meters.
- Facility role bitmask: `BusStop`, `Signal`, `School`, `Office`, `Mall`.

### Dynamic Nodes (`NodeDynamic`)
- Instantaneous water depth ($h_{\text{flood}}$ in meters).
- Local precipitation rate ($P$ in mm/hr).
- Active pedestrian / transit passenger demand.

### Static Edges (`EdgeStatic`)
- Directed topology: `from_node`, `to_node`, `reverse_twin_edge`.
- Road classification: `Motorway`, `Primary`, `Secondary`, `Tertiary`, `Residential`, `Service`.
- Geometric attributes: Length ($L_e$ in meters), lane count, baseline free-flow speed ($v_{\text{free}}$ in m/s), theoretical capacity ($C_e$ in veh/hr).
- Explicit polyline geometry for rendering.

### Dynamic Edges (`EdgeDynamic`)
- Current vehicle count ($V_e$).
- Effective traversal speed ($v_{\text{eff}}$ in m/s).
- Speed multipliers: $f_{\text{weather}}$, $f_{\text{flood}}$, `incident_speed_multiplier`.
- Capacity multiplier: `incident_capacity_multiplier`.
- Closure flags: `is_closed` (manual/flooding), `incident_closed`.

---

## 3. Spatial Indexing

DSTNS integrates a 2D spatial R-Tree / bounding-box grid index (`SpatialIndex`):
- $O(\log N)$ nearest-node query for coordinate anchoring.
- Geographic range search for localized storm cells, congestion pockets, and bus stops.
