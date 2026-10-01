# Control API

Acting on a running world: speed, day type, modules, roads, signals, rain and
demand surges, with undo and redo. All routes are under `/api/v1/control`;
every one except `tick-rate` needs a world (409 or 400 otherwise). They refuse cross-site browser requests (see
[Security](../SECURITY.md#cross-site-request-forgery)), and errors follow
[API errors](errors.md).

The observer uses only the tick rate. The other controls are for the CLI,
scripts and tests, and every one is recorded in the run's history, news and
journal.

| Method | Route | Purpose | Undoable |
|---|---|---|---|
| PUT | `/tick-rate` | Speed multiplier | yes |
| POST | `/day` | Weekday or weekend | yes |
| PUT | `/modules/{module}` | Enable or disable a subsystem | yes |
| POST | `/modules/{module}/enable`, `/disable` | The same | yes |
| PUT | `/edges/{id}` | Override one directed edge | yes |
| POST | `/edges/{id}/override` | The same | yes |
| POST | `/events/traffic` | Congestion on one edge | yes |
| POST | `/signals/{node}` | Toggle a junction's forced phase | yes |
| POST | `/signals/{node}/toggle` | The same | yes |
| POST | `/events/weather` | Manual storm | yes (intensity to 0) |
| POST | `/events/surge` | Demand surge | no |
| POST | `/undo`, `/redo` | Step through history | |
| GET | `/history` | The history | |
| POST | `/transit/route` | Retired: 410 `TRANSIT_API_RETIRED` | |

## PUT /tick-rate

```json
{ "tick_rate": 2 }
```

(0, 5]. The interface offers 0.25, 0.5, 1, 2, 3 and 5. ASB may hold the
applied rate below the request while the observer is behind; the request is
remembered and restored when it catches up.

```json
{ "command_id": 4, "previous_tick_rate": 1, "tick_rate": 2, "requested_tick_rate": 2,
  "rate_governed_by_asb": false, "base_rate": 24, "target_virtual_rate": 48 }
```

## POST /day

`{"day": 0}` for a weekday, `{"day": 1}` for a weekend. The demand schedule is
rebuilt for the new day type from the current time onwards.

## PUT /modules/{module}

`{"enabled": false}`. Modules: `traffic`, `signals`, `buildings`, `dws`,
`flooding`, `news`. See [Configuration](../CONFIGURATION.md#modules) for what
each one turns off.

## Edge overrides

```json
PUT /api/v1/control/edges/412
{ "speed_multiplier": 0.5, "capacity_multiplier": 0.6, "closed": false }
```

Multipliers in [0, 2], default 1. `{id}` must be a 32-bit directed edge ID in
the graph. The override is a separate channel, composed with weather,
incidents and signals rather than replacing them, and it stands across seeks
until undone.

`POST /events/traffic` is a shorthand for congestion on one edge:

```json
{ "target": { "type": "edge", "id": 412 }, "congestion_pressure": 0.8 }
```

Pressure in [0, 1] sets the capacity multiplier to `1 − 0.75 × pressure`.

## Signals

`POST /signals/{node}` toggles the node between forcing north-south and
east-west approaches green (the first toggle forces east-west). Undo returns
the junction to its own timing plan.

```json
{ "command_id": 7, "node_id": 1881, "phase": 2, "phase_label": "PHASE_2_EW_GREEN" }
```

## POST /events/weather

```json
{ "epicenter_node": 1881, "intensity": 0.85, "radius_m": 350,
  "duration_virtual_minutes": 60, "flood_gain": 0.5 }
```

| Field | Range | Default |
|---|---|---|
| `epicenter_node` | a node ID | required |
| `intensity` | [0, 1] | 0.85 |
| `radius_m` | > 0 | 350 |
| `duration_virtual_minutes` | [1, 1440] | 60 |
| `flood_gain` | [0, 1] | 0.5 |

Returns 202. Manual storms start at the current time, or 5 playback seconds
after the previous manual storm, whichever is later, so they never pile up on
one instant; `delayed_by_dws_gate` says whether that happened.

## POST /events/surge

```json
{ "node_id": 1881, "factor": 1.8, "radius_m": 350, "duration_s": 1800 }
```

| Field | Range | Default |
|---|---|---|
| `node_id` | a node ID | required |
| `factor` | (0, 10] | 1.8 |
| `radius_m` | (0, 20000] | 350 |
| `duration_s` | [1, 86400] virtual seconds | 1800 |

Returns 202. The surge rises and falls smoothly over its life and ends at
midnight at the latest.

## Undo, redo and history

`POST /undo` and `POST /redo` take `{"count": N}` with N in [1, 10000]
(default 1):

```json
{ "undone": [7, 6], "undo_depth": 3, "redo_depth": 2 }
```

Any new control clears the redo stack. `GET /history` lists applied and undone
commands with their IDs, types and the virtual time each was applied. Undo is
logical: it restores the control's value from now on, and does not rewind
what the control did while it was in force. See [Simulation
engine](../simulation-engine.md#undo-and-redo).
