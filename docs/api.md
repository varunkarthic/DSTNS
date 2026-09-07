# DSTNS Unified REST API Reference

The DSTNS HTTP server exposes a versioned, RESTful API on `/api/v1/*` using `cpp-httplib`. All responses follow a standard envelope:

```json
{
  "ok": true,
  "data": { ... }
}
```
Or in error conditions:
```json
{
  "ok": false,
  "error": "Error description message",
  "code": 400
}
```

---

## 1. System Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Heartbeat probe returning engine status and memory metrics. |
| `GET` | `/api/v1/system/version` | Version, compiler, and git commit metadata. |

---

## 2. Playback Lifecycle Endpoints

| Method | Path | Payload | Description |
|---|---|---|---|
| `POST` | `/api/v1/playback/prepare` | `{"seed": "...", "duration": 1200}` | Compiles scenario without advancing clock. |
| `POST` | `/api/v1/playback/start` | `{"seed": "...", "duration": 600}` | Begins or resumes simulation execution. |
| `POST` | `/api/v1/playback/pause` | `{}` | Suspends clock and physics advancement. |
| `POST` | `/api/v1/playback/play` | `{}` | Resumes execution from paused state. |
| `POST` | `/api/v1/playback/seek` | `{"target_time": "14:30:00"}` | Jumps virtual time to designated second. |
| `POST` | `/api/v1/playback/stop` | `{}` | Halts simulation and purges state. |
| `GET` | `/api/v1/playback/status` | — | Current state, time, elapsed/remaining seconds. |

---

## 3. View & Telemetry Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/view/topology` | Full road network graph (nodes, edges, polyline geometries, facility anchors). |
| `GET` | `/api/v1/view/snapshot` | Dynamic state vector (edge speeds, vehicle counts, active storms, active incidents, buses). |
| `GET` | `/api/v1/view/incidents` | Complete catalog of scenario incidents with lifecycles and multipliers. |
| `GET` | `/api/v1/view/metrics` | Aggregate network KPIs (average speed, total travel time, congestion index). |
| `GET` | `/api/v1/news` | Paginated simulation news and incident announcements. |

---

## 4. Operator Control Endpoints

| Method | Path | Payload | Description |
|---|---|---|---|
| `POST` | `/api/v1/control/transit/route` | `{"bus_id": "...", "nodes": [...]}` | Validates and dispatches public transit bus. |
| `POST` | `/api/v1/control/events/road_closure` | `{"edge_id": 42, "closed": true}` | Manually closes or re-opens road edge. |
| `POST` | `/api/v1/control/events/weather` | `{"epicenter_node": 10}` | Injects localized storm cell. |
| `POST` | `/api/v1/control/events/surge` | `{"node_id": 15, "factor": 2.5}` | Injects localized traffic demand surge. |
| `POST` | `/api/v1/control/signals/override` | `{"node_id": 10, "state": "GREEN"}` | Holds traffic signal phase. |
