# DSTNS REST API Reference

The Deterministic Spatiotemporal Transport Network Simulator (DSTNS) exposes a low-latency HTTP/JSON REST API along with Server-Sent Events (SSE) telemetry streams on port `8090`.

---

## API Subsystems Overview

| Subsystem | Base Route | Documentation | Description |
| :--- | :--- | :--- | :--- |
| **View & Telemetry** | `/api/v1/view/*` | [View API Guide](view-api.md) | Map topology, bounding box, snapshot, signals, weather, and active transit buses. |
| **Playback & Clock** | `/api/v1/playback/*` | [Playback API Guide](playback-api.md) | Simulation lifecycle: `prepare`, `start`, `pause`, `play`, `stop`, `reset`, `seek`. |
| **Control & Overrides**| `/api/v1/control/*` | [Control API Guide](control-api.md) | Transit route dispatcher, weather events, traffic surges, road closures, modules. |
| **News Ledger** | `/api/v1/news/*` | [News API Guide](news-api.md) | Chronological incident journal, news events, and SSE live news streaming. |
| **System & Status** | `/health`, `/api/v1/system/*` | [System API Guide](system-api.md) | Health checks, metrics, process status, and graceful termination (`/terminate`). |

---

## Quick-Start Cheat Sheet

### 1. Health & Status
```bash
# Server health check
curl -s http://127.0.0.1:8090/health | jq .

# Playback clock & lifecycle status
curl -s http://127.0.0.1:8090/api/v1/playback/status | jq .
```

### 2. Prepare & Load Map with Seed
```bash
# Load map in standby (READY) without auto-starting
curl -X POST http://127.0.0.1:8090/api/v1/playback/prepare \
  -H "Content-Type: application/json" \
  -d '{"seed": "9876543210123456", "day": 0}'
```

### 3. Fetch Map Topology
```bash
# Get nodes, edges, geometries, and bounds
curl -s http://127.0.0.1:8090/api/v1/view/topology | jq .
```

### 4. Start Simulation
```bash
# Start advancing virtual clock
curl -X POST http://127.0.0.1:8090/api/v1/playback/start \
  -H "Content-Type: application/json" \
  -d '{"playback_duration_seconds": 1200}'
```

### 5. Dispatch Public Transit Bus
```bash
# Dispatch bus across contiguous nodes (e.g. nodes 213 -> 6)
curl -X POST http://127.0.0.1:8090/api/v1/control/transit/route \
  -H "Content-Type: application/json" \
  -d '{"bus_id": "BUS-101", "label": "Downtown Shuttle", "nodes": [213, 6]}'
```

### 6. Inject Dynamic Weather Cell
```bash
# Inject rain with random radius (100m - 600m)
curl -X POST http://127.0.0.1:8090/api/v1/control/events/weather \
  -H "Content-Type: application/json" \
  -d '{"epicenter_node": 10}'
```

### 7. Close a Road for Detours
```bash
curl -X PUT http://127.0.0.1:8090/api/v1/control/edges/14 \
  -H "Content-Type: application/json" \
  -d '{"closed": true}'
```

### 8. Seek Simulation Time
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/seek \
  -H "Content-Type: application/json" \
  -d '{"target_time": "17:30:00"}'
```
