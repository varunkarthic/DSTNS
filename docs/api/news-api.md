# News API (`/api/v1/news/*`)

The News API provides structured, human-readable notifications regarding simulation weather developments, traffic congestion warnings, and manual operator overrides.

## Endpoints

### 1. News Stream (`GET /api/v1/news/stream`)
Server-Sent Events emitting real-time notifications as events occur.

### 2. Event Message Format
```json
{
  "event_id": 1042,
  "event_type": "DWS_STARTED",
  "simulated_current_time": "08:15:00",
  "entity_type": "node",
  "entity_id": 18,
  "intensity": 0.85,
  "radius_m": 800.0,
  "message": "[08:15:00] DWS storm started at node 18 (intensity 0.85, radius 800m)"
}
```

### 3. News Categories
- `DWS_RAIN_STARTED` / `DWS_RAIN_ENDED`: Deterministic Weather Simulation events.
- `INCIDENT_ACTIVATED` / `INCIDENT_RESOLVED`: Incident Desk stochastic disruption events.
- `TRAFFIC_HOTSPOT_ACTIVE`: Recurrent peak congestion triggers.
- `ROAD_CLOSED` / `ROAD_RESTORED`: Flooding or manual closure changes.
- `CONTROL_OVERRIDE`: Manual operator parameter updates.
