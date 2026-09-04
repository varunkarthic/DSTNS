# Playback & Lifecycle API (`/api/v1/playback/*`)

The Playback API controls the deterministic virtual clock, scenario generation, seed preparation, state progression, and historical timeline seek operations.

---

## 1. Lifecycle State Machine

```
      +-------------+
      |    IDLE     | <------------------------------------+
      +-------------+                                      |
             |                                             |
             | prepare (compiles scenario & loads map)     |
             v                                             |
      +-------------+                                      |
      |    READY    |                                      |
      +-------------+                                      |
             |                                             |
             | start / play                                | stop / reset
             v                                             |
      +-------------+      pause      +-------------+      |
      |   RUNNING   | --------------> |   PAUSED    |      |
      +-------------+ <-------------- +-------------+      |
             |             play              |             |
             |                               |             |
             +-------------------------------+-------------+
             |
             | duration completed
             v
      +-------------+
      |  COMPLETED  |
      +-------------+
```

---

## 2. Prepare Scenario without Auto-Starting (`POST /api/v1/playback/prepare`)

Compiles a deterministic road network topology and scenario for a given seed, and transitions the engine into `READY` state. This loads the map and all building anchors without advancing the virtual clock, allowing inspection before starting.

### Endpoint
* **Path**: `/api/v1/playback/prepare`
* **Method**: `POST`

### Request Parameters
| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `seed` | `string` / `number` | `"auto"` | 128-bit hex string, 16-digit numeric string, or `"auto"`. |
| `playback_duration_seconds` | `number` | `1200` | Real-world duration to play the full 24-hour virtual day $[60, 3600]$. |
| `day` | `number` | `0` | `0` = Weekday (Commuter & School Rush), `1` = Weekend (Leisure & Shopping Peak). |
| `tick_rate` | `number` | `1.0` | Initial virtual rate multiplier $[0.1, 100.0]$. |
| `modules` | `object` | All `true` | Module enable flags (`traffic`, `signals`, `buildings`, `dws`, `flooding`, `news`). |
| `dws` | `object` | `{"frequency": 3}` | Dynamic weather storm count per 24h day. |

#### Example Request:
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "seed": "0x508905019bc2221d083c848bf3e12e22",
    "playback_duration_seconds": 1200,
    "day": 0,
    "tick_rate": 1.0,
    "modules": {
      "traffic": true,
      "signals": true,
      "buildings": true,
      "dws": true,
      "flooding": true,
      "news": true
    },
    "dws": {
      "frequency": 4
    }
  }'
```

---

## 3. Start Simulation Run (`POST /api/v1/playback/start`)

Initializes or unpauses a deterministic simulation run, advancing the virtual clock continuously.

#### Example: Quick-Start with 16-digit Numeric Seed
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/start \
  -H "Content-Type: application/json" \
  -d '{
    "seed": "9876543210987654",
    "playback_duration_seconds": 600,
    "day": 1
  }'
```

### Successful Response (`200 OK`):
```json
{
  "ok": true,
  "lifecycle": "RUNNING",
  "run_id": "run_877a90265c24",
  "seed": "0x00000000000000008bd03164923f9846",
  "resolved_config": {
    "day": 1,
    "playback_duration_seconds": 600,
    "tick_rate": 1.0
  },
  "stream": {
    "snapshot": "/api/v1/view/snapshot",
    "bulk_stream": "/api/v1/view/stream",
    "news_stream": "/api/v1/news/stream"
  },
  "message": "Simulation accepted and prepared."
}
```

---

## 4. Playback Controls (`pause`, `play`, `stop`, `reset`)

### Pause Simulation (`POST /api/v1/playback/pause`)
Freezes the virtual clock while keeping all state intact.
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/pause -H "Content-Type: application/json" -d '{}'
```

### Resume Playback (`POST /api/v1/playback/play`)
Resumes virtual clock progression from current point.
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/play -H "Content-Type: application/json" -d '{}'
```

### Stop Simulation (`POST /api/v1/playback/stop`)
Halts simulation and releases active scenario runners.
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/stop -H "Content-Type: application/json" -d '{}'
```

### Reset Runtime (`POST /api/v1/playback/reset`)
Reverts the simulation clock back to 00:00:00 and clears dynamic traffic overlays while preserving compiled map topology.
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/reset -H "Content-Type: application/json" -d '{}'
```

---

## 5. Timeline Seek (`POST /api/v1/playback/seek`)

Jumps the simulation clock to an exact virtual time of day (`HH:MM:SS` format) or percentage ($0.0 - 1.0$). The engine reconstructs all deterministic state, signal phases, weather cells, and vehicle queues via fast-forward checkpoint replay.

#### Example Request:
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/seek \
  -H "Content-Type: application/json" \
  -d '{"target_time": "14:30:00"}'
```

### Response:
```json
{
  "ok": true,
  "previous_time": "08:15:22",
  "simulated_current_time": "14:30:00",
  "virtual_day_seconds": 52200,
  "state_revision": 1420
}
```

---

## 6. Query Playback Status (`GET /api/v1/playback/status`)

Returns the current lifecycle state, virtual clock position, progress percentage, and active configuration.

#### Example Request:
```bash
curl -s http://127.0.0.1:8090/api/v1/playback/status | jq .
```

### Response Structure:
```json
{
  "ok": true,
  "api_version": "1.0",
  "run_id": "run_877a90265c24",
  "data": {
    "lifecycle": "RUNNING",
    "seed": "0x00000000000000008bd03164923f9846"
  },
  "clock": {
    "simulated_current_time": "11:24:30",
    "virtual_day_seconds": 41070,
    "simulation_percentage": 0.475,
    "tick_rate": 1.0,
    "target_virtual_rate": 72.0
  }
}
```
