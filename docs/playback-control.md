# Playback Control & Simulation Lifecycle

The Playback Controller (`PlaybackEngine` in `src/engine.cpp`, `include/dstns/engine.hpp`) manages the simulation clock, operational states, time-scaling multipliers, and operator controls.

---

## 1. Lifecycle State Machine

The simulation lifecycle transitions between five well-defined states:

```text
    +-----------+
    |   IDLE    | <───────────────────────────+
    +-----------+                             |
          |                                   |
          | prepare(seed, config)             |
          v                                   |
    +-----------+                             |
    | PREPARED  |                             |
    +-----------+                             |
          |                                   |
          | start()                           |
          v                                   |
    +-----------+       pause()         +-----------+
    |  RUNNING  | ────────────────────> |  PAUSED   |
    +-----------+ <──────────────────── +-----------+
          |             play()                |
          |                                   |
          +───────────────+───────────────────+
                          |
                          | stop() / reset() / duration elapsed
                          v
                    +------------+
                    | TERMINATED | ───────────+
                    +------------+
```

### State Definitions
- **`IDLE`**: Server running without an active compiled scenario.
- **`PREPARED`**: Road network, signals, stops, DWS storms, and incidents compiled and ready in memory. Clocks remain frozen at $t=0$ or seek target.
- **`RUNNING`**: The simulation thread actively advances the virtual day clock and integrates vehicle physics.
- **`PAUSED`**: Physics integration suspended. API and inspection endpoints remain fully operational.
- **`TERMINATED`**: Simulation duration reached or operator stopped. Final summary reports generated.

---

## 2. API Endpoints

### 1. Prepare Scenario: `POST /api/v1/playback/prepare`
Loads and compiles scenario graph, DWS weather cells, and incident schedule:
```json
{
  "seed": "9876543210987654",
  "playback_duration_seconds": 1200,
  "day": 0
}
```

### 2. Start Simulation: `POST /api/v1/playback/start`
Prepares (if not already prepared) and transitions into `RUNNING` mode:
```json
{
  "seed": "9876543210987654",
  "playback_duration_seconds": 600,
  "day": 1
}
```

### 3. Pause & Play: `POST /api/v1/playback/pause`, `POST /api/v1/playback/play`
Freezes or unfreezes simulation advancement:
```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/pause -H "Content-Type: application/json" -d '{}'
curl -X POST http://127.0.0.1:8090/api/v1/playback/play -H "Content-Type: application/json" -d '{}'
```

### 4. Time Seek: `POST /api/v1/playback/seek`
Jumps to a target time of day (`HH:MM:SS` or integer seconds from midnight):
```json
{
  "target_time": "14:30:00"
}
```

### 5. Status & Telemetry: `GET /api/v1/playback/status`
Returns real-time status including elapsed seconds, remaining seconds, active state, and tick rate:
```json
{
  "ok": true,
  "data": {
    "state": "RUNNING",
    "virtual_time_s": 28800,
    "virtual_time_str": "08:00:00",
    "elapsed_wall_s": 45.2,
    "remaining_virtual_s": 57600,
    "tick_rate": 1.0,
    "seed": "9876543210987654",
    "total_nodes": 12450,
    "total_edges": 28310
  }
}
```
