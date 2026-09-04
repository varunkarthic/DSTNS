# View API (`/api/v1/view/*`)

The View API provides read-only queries for topology, snapshots, static elements, and logs.

## Endpoints

### 1. Global View API (`GET /api/v1/view/global`)
The single comprehensive state endpoint returning all static and dynamic parameters across every node and edge in the network, updated live every second. Also available at `/api/v1/view/world`, `/api/v1/view/all`, and `/api/v1/view/global.json`.

In addition, the server atomically writes this complete JSON to disk at `logs/global_view.json` every second.

#### cURL Request:
```bash
# Query live global view via HTTP
curl -s http://127.0.0.1:8090/api/v1/view/global | jq .

# Inspect network metrics only
curl -s http://127.0.0.1:8090/api/v1/view/global | jq .data.metrics

# Inspect first edge parameters
curl -s http://127.0.0.1:8090/api/v1/view/global | jq .data.edges[0]

# Inspect direct file written every second on disk
cat logs/global_view.json | jq .data.metrics
```

#### Response Structure:
```json
{
  "ok": true,
  "api_version": "1.0",
  "run_id": "run_9bc2221d083c",
  "global_seed": "0x508905019bc2221d083c848bf3e12e22",
  "state_revision": 1420,
  "config_revision": 1,
  "clock": {
    "playback_state": "RUNNING",
    "simulated_current_time": "14:30:00",
    "virtual_day_seconds": 52200,
    "simulation_percentage": 0.604,
    "tick_rate": 1.0,
    "base_rate": 720.0,
    "target_virtual_rate": 720.0
  },
  "data": {
    "product": "Deterministic Simulated Environment",
    "version": "1.0.0",
    "lifecycle": "RUNNING",
    "bounds": {
      "min_lat": 23.0185,
      "max_lat": 23.0450,
      "min_lon": 72.5682,
      "max_lon": 72.5920,
      "center_lat": 23.0317,
      "center_lon": 72.5801
    },
    "metrics": {
      "total_nodes": 121,
      "total_edges": 436,
      "total_vehicles": 736,
      "mean_network_speed_mps": 11.2,
      "mean_network_speed_kmh": 40.32,
      "mean_network_congestion": 0.045,
      "active_weather_count": 1,
      "flooded_edges_count": 0,
      "closed_edges_count": 0
    },
    "nodes": [
      {
        "id": 0,
        "osm_node_id": 9000000000,
        "position": {"lat": 23.0185, "lon": 72.5682, "x_m": 0.0, "y_m": 0.0},
        "degree": 2,
        "flood_susceptibility": 0.45,
        "drainage": 0.62,
        "roles": {"bus_stop": false, "signal": false, "building": false},
        "building": null,
        "time_windows": [],
        "dynamic": {
          "rainfall": 0.0,
          "flood": 0.0,
          "building_effect": 0.0,
          "state_revision": 1420
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
        "segment_index": 0,
        "road_class": "Secondary",
        "lanes": 1,
        "source_oneway": false,
        "synthetic_reverse": false,
        "length_m": 180.0,
        "free_speed_mps": 13.88,
        "free_speed_kmh": 50.0,
        "base_capacity_vph": 900.0,
        "hotspot_susceptibility": 0.0,
        "flood_susceptibility": 0.42,
        "geometry": [
          {"lat": 23.0185, "lon": 72.5682, "x_m": 0.0, "y_m": 0.0},
          {"lat": 23.0185, "lon": 72.5699, "x_m": 180.0, "y_m": 0.0}
        ],
        "dynamic": {
          "demand_vph": 210.5,
          "effective_capacity_vph": 900.0,
          "effective_speed_mps": 13.88,
          "effective_speed_kmh": 50.0,
          "mean_speed_mps": 13.5,
          "mean_speed_kmh": 48.6,
          "vehicle_count": 2,
          "halting_count": 0,
          "occupancy": 0.055,
          "congestion": 0.02,
          "congestion_model": 0.005,
          "congestion_observed": 0.035,
          "rainfall": 0.0,
          "flood": 0.0,
          "closed": false,
          "manual_closed": false,
          "signal_multiplier": 1.0,
          "rain_speed_multiplier": 1.0,
          "flood_speed_multiplier": 1.0,
          "rain_capacity_multiplier": 1.0,
          "flood_capacity_multiplier": 1.0,
          "manual_speed_multiplier": 1.0,
          "manual_capacity_multiplier": 1.0,
          "state_revision": 1420
        }
      }
    ],
    "weather": {
      "active_count": 1,
      "active_events": [],
      "scheduled_events": []
    },
    "signals": [],
    "bus_stops": [],
    "buildings": [],
    "active_incidents": [],
    "recent_events": []
  }
}
```

### 2. Static Topology (`GET /api/v1/view/topology`)
Returns the canonical road topology. Includes node array, indexed edge array, and bounding box:
```json
{
  "ok": true,
  "data": {
    "run_id": "run_01",
    "topology_revision": 1,
    "bounds": {"min_lat": 23.0, "max_lat": 23.05, "min_lon": 72.55, "max_lon": 72.60},
    "nodes": [
      {"id": 0, "osm_node_id": 9000000000, "position": {"lat": 23.0, "lon": 72.0, "x_m": 0.0, "y_m": 0.0}, "degree": 4}
    ],
    "edges": [
      {"id": 0, "from": 0, "to": 1, "length_m": 120.0, "road_class": "Residential", "lanes": 1}
    ]
  }
}
```

### 3. Full Dynamic Snapshot (`GET /api/v1/view/snapshot`)
Returns current dynamic state vector across all nodes and edges:
```json
{
  "ok": true,
  "state_revision": 1420,
  "data": {
    "clock": {"simulated_current_time": "14:30:00", "simulation_percentage": 0.604},
    "nodes": [
      {"id": 0, "rainfall": 0.0, "flood": 0.0, "building_effect": 0.1}
    ],
    "edges": [
      {"id": 0, "congestion": 0.12, "rainfall": 0.0, "flood": 0.0, "effective_speed_mps": 13.8, "vehicle_count": 4, "closed": false}
    ]
  }
}
```

### 4. Bulk State Stream (`GET /api/v1/view/stream`)
Server-Sent Events (SSE) emitting complete dynamic snapshots every 1 real second.

### 5. Scenario Manifest (`GET /api/v1/view/manifest`)
Returns `scenario_hash`, `graph_hash`, seed, and module metadata.

### 6. Specialized Views
- `GET /api/v1/view/global` (Full state in single JSON)
- `GET /api/v1/view/traffic`
- `GET /api/v1/view/weather`
- `GET /api/v1/view/bus-stops`
- `GET /api/v1/view/buildings`
- `GET /api/v1/view/signals`
- `GET /api/v1/view/events`
- `GET /api/v1/view/metrics`
- `GET /api/v1/view/logs/api`
- `GET /api/v1/view/logs/events`
- `GET /api/v1/view/logs/system`

