# View & Map Telemetry API (`/api/v1/view/*`)

The View API provides comprehensive read-only access to compiled OpenStreetMap (OSM) topologies, real-time snapshot envelopes, signal phases, weather storm catalogs, active bus positions, and low-latency Server-Sent Events (SSE) telemetry.

---

## 1. Map Topology Fetch (`GET /api/v1/view/topology`)

Fetches the immutable road network graph compiled from OpenStreetMap data for the current deterministic seed.

### Endpoint
* **Path**: `/api/v1/view/topology`
* **Method**: `GET`

#### cURL Request:
```bash
# Fetch full topology
curl -s http://127.0.0.1:8090/api/v1/view/topology | jq .

# Extract map bounding box & geographic center
curl -s http://127.0.0.1:8090/api/v1/view/topology | jq .data.bounds

# List all nodes with facility roles (Bus Stops, Signals, Schools, Malls, Offices, Shops)
curl -s http://127.0.0.1:8090/api/v1/view/topology | jq '.data.nodes[] | {id: .id, lat: .position.lat, lon: .position.lon, roles: .roles}'

# Inspect first edge geometry (polyline coordinates)
curl -s http://127.0.0.1:8090/api/v1/view/topology | jq .data.edges[0]
```

### Response Schema
```json
{
  "ok": true,
  "api_version": "1.0",
  "run_id": "run_877a90265c24",
  "data": {
    "graph_hash": "a58f4bc93...",
    "scenario_hash": "71df1e03...",
    "bounds": {
      "min_lat": 23.0185,
      "max_lat": 23.0450,
      "min_lon": 72.5682,
      "max_lon": 72.5920,
      "center_lat": 23.0317,
      "center_lon": 72.5801
    },
    "nodes": [
      {
        "id": 0,
        "osm_node_id": 9000000000,
        "position": {
          "lat": 23.0185,
          "lon": 72.5682,
          "x_m": 0.0,
          "y_m": 0.0
        },
        "degree": 3,
        "signal": true,
        "roles": {
          "bus_stop": false,
          "signal": true,
          "building": true
        },
        "building": {
          "type": "school",
          "name": "Oakridge Academy",
          "capacity": 800,
          "base_draw": 350.0
        }
      }
    ],
    "edges": [
      {
        "id": 0,
        "from": 0,
        "to": 1,
        "reverse_twin": 1,
        "osm_way_id": 8000000000,
        "road_class": "Primary",
        "lanes": 2,
        "length_m": 142.8,
        "free_speed_mps": 13.88,
        "base_capacity_veh_per_hour": 1800,
        "geometry": [
          {"lat": 23.0185, "lon": 72.5682},
          {"lat": 23.0192, "lon": 72.5695},
          {"lat": 23.0201, "lon": 72.5710}
        ]
      }
    ]
  }
}
```

---

## 2. Dynamic Network Snapshot (`GET /api/v1/view/snapshot`)

Returns the exact real-time state of the entire network at the current virtual clock tick, including traffic density, signal lights, rain storm centers, edge speeds, and active transit buses.

#### cURL Request:
```bash
# Query instantaneous snapshot
curl -s http://127.0.0.1:8090/api/v1/view/snapshot | jq .

# Inspect all active transit buses
curl -s http://127.0.0.1:8090/api/v1/view/snapshot | jq .data.active_transit_buses

# Inspect active traffic signals
curl -s http://127.0.0.1:8090/api/v1/view/snapshot | jq .data.signals
```

### Snapshot Response Structure:
```json
{
  "ok": true,
  "api_version": "1.0",
  "state_revision": 1482,
  "clock": {
    "simulated_current_time": "14:24:18",
    "virtual_day_seconds": 51858,
    "simulation_percentage": 0.600,
    "tick_rate": 1.0
  },
  "data": {
    "edges": [
      {
        "id": 0,
        "congestion": 0.28,
        "vehicle_count": 8,
        "effective_speed_mps": 9.8,
        "free_speed_mps": 13.88,
        "closed": false,
        "flooded": false,
        "water_depth_mm": 0.0
      }
    ],
    "signals": [
      {
        "node_id": 0,
        "phase": 0,
        "phase_name": "NS_GREEN",
        "ns_green": true,
        "ew_green": false,
        "elapsed_seconds": 18.0,
        "phase_duration_seconds": 35.0
      }
    ],
    "weather": [
      {
        "event_id": 1000000,
        "epicenter_node": 45,
        "lat": 23.0285,
        "lon": 72.5742,
        "intensity": 0.85,
        "radius_m": 350.0,
        "active": true
      }
    ],
    "active_transit_buses": [
      {
        "bus_id": "BUS-METRO-42",
        "label": "Downtown Express",
        "nodes": [0, 1, 4],
        "route_edges": [0, 6],
        "total_distance_m": 380.5
      }
    ]
  }
}
```

---

## 3. Global Comprehensive State (`GET /api/v1/view/global`)

Combines topology, nodes, edges, buildings, dynamic metrics, and clock status in a single consolidated response. (Also written to `logs/global_view.json` every second).

```bash
curl -s http://127.0.0.1:8090/api/v1/view/global | jq .
```

---

## 4. Weather Catalog (`GET /api/v1/view/weather`)

Lists all pre-scheduled (DWS) and manual weather storms for the current 24-hour run.

```bash
curl -s http://127.0.0.1:8090/api/v1/view/weather | jq .data.items
```

---

## 5. Live Telemetry Stream via SSE (`GET /api/v1/view/stream`)

Streams real-time JSON snapshots to connected clients using Server-Sent Events (`text/event-stream`).

```bash
# Listen to live server telemetry stream
curl -N http://127.0.0.1:8090/api/v1/view/stream
```
