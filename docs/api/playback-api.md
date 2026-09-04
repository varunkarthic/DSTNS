# Playback API (`/api/v1/playback/*`)

The Playback API controls simulation execution, time progression, pausing, seeking, and teardown.

## 1. Start Simulation
- **Endpoint**: `POST /api/v1/playback/start`
- **Purpose**: Transitions from `IDLE` to `PREPARING` -> `RUNNING` (or `PAUSED`).
- **Request Body**:
```json
{
  "seed": "0x123456789ABCDEF0",
  "playback_duration_seconds": 1200,
  "start_virtual_time": "00:00:00",
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
}
```
- **Response**: `202 Accepted`
```json
{
  "ok": true,
  "lifecycle": "RUNNING",
  "run_id": "run_01",
  "seed": "0x123456789abcdef0",
  "message": "simulation started"
}
```

## 2. Playback Status
- **Endpoint**: `GET /api/v1/playback/status`
- **Purpose**: Returns real-time execution telemetry and clock status.
- **Response**: `200 OK`
```json
{
  "ok": true,
  "data": {
    "run_id": "run_01",
    "lifecycle": "RUNNING",
    "clock": {
      "simulated_current_time": "14:30:00",
      "simulated_seconds": 52200,
      "simulation_percentage": 0.60416,
      "base_rate": 72.0,
      "tick_rate": 1.0,
      "target_virtual_rate": 72.0,
      "effective_virtual_rate": 71.9,
      "paused": false
    },
    "state_revision": 1420
  }
}
```

## 3. Pause Simulation
- **Endpoint**: `POST /api/v1/playback/pause`
- **Purpose**: Halts time evolution while keeping server operational.

## 4. Resume Simulation
- **Endpoint**: `POST /api/v1/playback/play`
- **Purpose**: Resumes time advancement from current position or specified `resume_from`.

## 5. Seek Simulation Time
- **Endpoint**: `POST /api/v1/playback/seek`
- **Purpose**: Reconstructs state at target virtual time using checkpoint replay.
- **Request Body**:
```json
{
  "target_time": "15:30:00"
}
```

## 6. Stop Simulation
- **Endpoint**: `POST /api/v1/playback/stop` (Alias: `POST /stop`)
- **Purpose**: Stops active simulation and transitions to `STOPPED`.

## 7. Reset Runtime
- **Endpoint**: `POST /api/v1/playback/reset`
- **Purpose**: Resets runtime state to `IDLE`.
