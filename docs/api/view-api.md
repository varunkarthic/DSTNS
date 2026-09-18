# Observation API

All routes below retain the versioned envelope with run ID, revisions, clock and data. See [API reference](../api.md) for the full route catalog.

| Route | Payload |
| --- | --- |
| `GET /api/v1/view/topology` | Static projected nodes/edges, road names/tags, footprints/POIs, projection origin, source/version metadata |
| `GET /api/v1/view/snapshot` | Aggregate edge traffic, independently scheduled signal groups, demand states/causes, active weather/incidents, congestion tracker |
| `GET /api/v1/view/congestion` | Current weighted congestion, evolving EMA and virtual-minute samples |
| `GET /api/v1/view/event-queue` | `view=future` or `history`, category, offset, limit (1–200) |
| `GET /api/v1/view/signals` | Actual controller state; operator overrides have null next-transition/time-in-phase and an explicit override flag |
| `GET /api/v1/view/global` | Combined state, also dumped to logs every ten wall seconds |
| `GET /api/v1/view/weather` | Weather schedule/catalog |
| `GET /api/v1/view/events` | Legacy weather catalog; use `event-queue` for scheduler inspection |

```
curl -s http://127.0.0.1:8090/api/v1/view/snapshot | jq .data.signals
curl -s 'http://127.0.0.1:8090/api/v1/view/event-queue?view=future&category=signals&limit=30'
```

Clock `simulation_percentage` is a fraction from 0 to 1. Edge congestion is 0–1; network Current/Average are 0–100. Rainfall and flood remain separate fields. Future signal entries show the next pending transition per controller; history retains 2,000 executions with an all-time counter. Retired Transit bus records are no longer present. The engine reports aggregate vehicle counts, not individual telemetry. See [model boundaries](../modernization.md#transit-migration-and-model-boundaries).
