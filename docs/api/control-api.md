# Control API (`/api/v1/control/*`)

The Control API provides dynamic runtime interventions, event injections, road network overrides, transit bus route dispatching, module controls, and transactional undo/redo capabilities.

---

## 1. Transit Route Dispatcher (`POST /api/v1/control/transit/route`)

Dispatches a public transit bus along an ordered sequence of contiguous road network nodes. The engine validates the single linked-list adjacency across all specified nodes, computes total route distance, registers the active bus for live snapshot serialization, and broadcasts an operational dispatch event to the news ledger.

### Endpoint
* **Path**: `/api/v1/control/transit/route`
* **Method**: `POST`
* **Content-Type**: `application/json`

### Request Body Schema
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `nodes` | `uint32[]` | **Yes** | Ordered array of at least 2 adjacent node IDs defining the traversal path. |
| `bus_id` | `string` | No | Unique transit identifier (default: `"BUS-101"`). |
| `label` | `string` | No | Human-readable route or line label (e.g. `"Metro Line 4 Express"`). |

#### Example Request:
```bash
curl -X POST http://127.0.0.1:8090/api/v1/control/transit/route \
  -H "Content-Type: application/json" \
  -d '{
    "bus_id": "BUS-METRO-42",
    "label": "Downtown University Express",
    "nodes": [213, 6, 14]
  }'
```

### Successful Response (`200 OK`)
When all consecutive node pairs `(nodes[i], nodes[i+1])` correspond to valid directed road edges:
```json
{
  "ok": true,
  "valid": true,
  "bus_id": "BUS-METRO-42",
  "label": "Downtown University Express",
  "node_count": 3,
  "route_edges": [0, 4],
  "total_distance_m": 248.5,
  "message": "Single linked list transit route validated successfully."
}
```

### Validation Failure Response (`400 Bad Request` or `valid: false`)
When a gap exists between non-adjacent nodes in the route:
```json
{
  "ok": false,
  "valid": false,
  "error_step": 0,
  "from_node": 140,
  "to_node": 226,
  "message": "Discontinuous route: Node #140 and Node #226 are not directly adjacent in the road network."
}
```

### Live Observation & Tracking
Once dispatched:
1. The bus is stored in the engine's active transit fleet.
2. Every subsequent `/api/v1/view/snapshot` or `/api/v1/view/global` response includes the bus in `active_transit_buses`:
   ```json
   "active_transit_buses": [
     {
       "bus_id": "BUS-METRO-42",
       "label": "Downtown University Express",
       "nodes": [213, 6, 14],
       "route_edges": [0, 4],
       "total_distance_m": 248.5
     }
   ]
   ```
3. The Web UI Map automatically renders and animates the bus traversing its route, pausing at bus stops and stopping at red traffic signals along the path.

---

## 2. Deterministic Weather Injection (`POST /api/v1/control/events/weather`)

Injects a localized deterministic rain storm cell onto the road network.

### Endpoint
* **Path**: `/api/v1/control/events/weather`
* **Method**: `POST`

### Request Body Schema
| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `epicenter_node` | `uint32` | **Required** | Node ID where the storm cell originates. |
| `intensity` | `double` | `0.85` | Rain intensity factor $[0.0, 1.0]$. |
| `radius_m` | `double` | `350.0` | Storm radius in meters $[100, 600]$. |
| `duration_virtual_minutes`| `double` | `60.0` | Virtual storm duration in minutes. |
| `flood_gain` | `double` | `0.5` | Flooding accumulation multiplier. |

#### Example Request:
```bash
# Inject rain with automatic random radius (100m - 600m)
curl -X POST http://127.0.0.1:8090/api/v1/control/events/weather \
  -H "Content-Type: application/json" \
  -d '{"epicenter_node": 45}'

# Inject custom rain cell
curl -X POST http://127.0.0.1:8090/api/v1/control/events/weather \
  -H "Content-Type: application/json" \
  -d '{
    "epicenter_node": 45,
    "intensity": 0.90,
    "radius_m": 350.0,
    "duration_virtual_minutes": 45.0,
    "flood_gain": 0.70
  }'
```

---

## 3. Traffic Surge Injection (`POST /api/v1/control/events/surge`)

Triggers a localized traffic surge or facility rush (e.g. school dismissal, corporate shift change, mall evening rush) with smooth normal-distribution ramp-up and ramp-down.

### Request Body Schema
| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `node_id` | `uint32` | **Required** | Target anchor node ID. |
| `factor` | `double` | `1.8` | Congestion multiplier ($> 1.0$). |
| `radius_m` | `double` | `350.0` | Spatial influence radius in meters. |
| `duration_s` | `uint32` | `1800` | Duration in virtual seconds (e.g. 1800s = 30 min). |

#### Example Request:
```bash
curl -X POST http://127.0.0.1:8090/api/v1/control/events/surge \
  -H "Content-Type: application/json" \
  -d '{"node_id": 12, "factor": 2.2, "radius_m": 400.0, "duration_s": 1800}'
```

---

## 4. Road Edge Overrides & Closures (`PUT /api/v1/control/edges/{edge_id}`)

Allows dynamic manual closure or capacity/speed regulation on specific directed road edges.

#### Example: Road Closure for Detours
```bash
curl -X PUT http://127.0.0.1:8090/api/v1/control/edges/14 \
  -H "Content-Type: application/json" \
  -d '{"closed": true}'
```

#### Example: Speed and Capacity Restriction
```bash
curl -X PUT http://127.0.0.1:8090/api/v1/control/edges/14 \
  -H "Content-Type: application/json" \
  -d '{"speed_multiplier": 0.4, "capacity_multiplier": 0.6, "closed": false}'
```

---

## 5. Virtual Tick Rate Acceleration (`PUT /api/v1/control/tick-rate`)

Controls simulation speed multiplier without skipping physics calculations.

```bash
# Accelerate to 10x
curl -X PUT http://127.0.0.1:8090/api/v1/control/tick-rate \
  -H "Content-Type: application/json" \
  -d '{"tick_rate": 10.0}'
```

---

## 6. Simulation Subsystem Module Toggles (`PUT /api/v1/control/modules/{module}`)

Dynamically enable or disable individual simulation sub-engines:
* Available modules: `traffic`, `signals`, `buildings`, `dws`, `flooding`, `news`.

```bash
# Disable deterministic weather simulation subsystem (DWS)
curl -X PUT http://127.0.0.1:8090/api/v1/control/modules/dws \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

---

## 7. Journal Undo & Redo (`POST /api/v1/control/undo`, `POST /api/v1/control/redo`)

Atomically unwinds or reapplies manual overlays and road overrides in the deterministic control journal.

```bash
# Undo last control action
curl -X POST http://127.0.0.1:8090/api/v1/control/undo \
  -H "Content-Type: application/json" \
  -d '{"count": 1}'
```
