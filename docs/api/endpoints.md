# Every endpoint

The whole API, route by route. For each one: who may call it, every field with its type and limits, what it answers, and what can go wrong. The responses are captured from a real server running a real world, so they show exactly what you get, shortened only where marked. They were recorded at API contract 1.4.

For a machine-readable description, see the [OpenAPI explorer](openapi.md). To build on this, see [Fabric](fabric-api.md) and [Building applications](../development/webfabric-apps.md). What protects all of it is in [Fabric and WebFabric security](security.md).

## Conventions

**Base.** `http://127.0.0.1:8090` by default. Everything is JSON, in UTF-8, over HTTP or, with a TLS build, HTTPS.

**Who can call what.** Four levels, explained in [security](security.md#who-can-do-what):

| Level | How you show it |
|---|---|
| Anyone | Nothing. Reading is open to anyone who can reach the port |
| Application | `Authorization: Bearer <token>`, from registering |
| Observer or operator | `X-DSTNS-Host: anything` from the observer's own origin, or `X-DSTNS-Operator: <credential>` |
| Operator | `X-DSTNS-Operator: <credential>` only, from `logs/operator.token` or `DSTNS_OPERATOR_TOKEN` |

**Shape of a response.** Reading answers `{"ok": true, "api_version": "1.4", "data": ...}`, and views also carry `run_id`, `seed`, `global_seed`, `lifecycle` and `clock`. Routes that act answer with what changed, such as `changed` and `lifecycle`. Failure is always:

```json
{ "ok": false, "api_version": "1.4", "error": { "code": "INVALID_REQUEST", "message": "A sentence for people" } }
```

`code` is stable, so match on it. `message` may change.

**Status codes.** `200` done. `202` accepted and carrying on. `400` malformed or out of range. `401` credential missing or wrong. `403` not allowed. `404` no such thing. `409` valid, but not in this state. `410` retired. `413` too large. `421` the `Host` isn't accepted. `422` doesn't fit this world. `429` too many; slow down. `500` a fault in the server. `503` a tool outside the server failed. See [errors](errors.md).

**Limits on every request.** A body may be up to 16 MiB, and JSON may nest up to 64 levels. Beyond those: `413` and `400`. Numbers must be finite. Unknown fields are ignored unless a route says otherwise.

**Paging.** `offset` and `limit`, where a route takes them. A `limit` above the route's ceiling is lowered to it, and a negative or non-numeric one is `400`.

**Times.** Simulated time is either seconds since midnight, 0 to 86400, or `"HH:MM:SS"`. Positions are metres from the projection's origin, with `x` east and `y` north.

**Headers on every response.** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. Under `/api/v1/fabric/`: `X-DSTNS-Content-SHA256`, and for a validly signed request, `X-DSTNS-Response-Signature`.

**Older routes.** Everything under `/api/v1/playback/` and `/api/v1/control/` still works, and is listed [below](#older-routes). New code should use `/api/v1/fabric/engine/`.

## Starting and moving through a run

All of these change the run. Under `/api/v1/fabric/engine/`, they need the observer or the operator. An application acts through [`POST .../control`](#post-apiv1fabricappsidcontrol).

### `POST /api/v1/fabric/engine/start`

Starts a run in the background: choosing the district, downloading its map if needed, and building the world. Follow it with `GET /api/v1/system/map-status` and `GET .../status`.

**Who:** The operator (`X-DSTNS-Operator`).

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `seed` | string or integer | No | Decimal, or `0x` and hex. Absent, `auto`, `random` or `0` draws a new one | Chooses the city and everything else |
| `playback_duration_seconds` | number | No |  | Real seconds a whole day takes |
| `tick_rate` | number | No | Above 0, up to 10. Default 1 | Speed multiplier |
| `day` | integer or `"auto"` | No | 0 weekday, 1 weekend | The kind of day |
| `start_virtual_time` | seconds or `HH:MM:SS` | No | Default 0 | Where the day begins |
| `saved_seed_id` | string | No | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` | Name it was saved under |
| `map_selection_version` | string | No | `urban-crfg-v3` (default); `urban-geo-v1` with engine `core-ng` | How districts are chosen. See [Deterministic seeding](../concepts/deterministic-seeding.md#choosing-countries-or-cities-urban-geo-v1) |
| `map_selection` | object | No | `mode`: `global`, `countries`, `cities` or `fixed_city`; `countries`: ISO 3166-1 alpha-2 codes; `cities`: city IDs such as `mumbai`; `exclude_countries`, `exclude_cities`: left out of what the mode allows (API 1.7); at most 200 of each | Only with `urban-geo-v1` (API 1.6). A policy that leaves out nothing has the same fingerprint as before exclusions existed |
| `engine` | string | No | `core-ng` (default since API 1.10) or `core-legacy`; another is refused with 400 | Which engine prepares and runs the world. Results are the same; `/system/info` lists the engines (API 1.5) |
| `map.osm_file` | string | No | A path, or `auto` | Use this file rather than downloading |
| `map.city_extent_m` | number | No | 500 to 20000 | How wide a district is |
| `map.district_nodes` | integer | No | 200 to 50000 | How many junctions |
| `map.max_nodes` | integer | No |  | An upper limit |
| `map.cache_dir` | string | No |  | Where maps are kept |
| `modules` | object | No | `traffic`, `signals`, `buildings`, `dws`, `flooding`, `news`: true or false | Which subsystems run |
| `dws.frequency` | number | No |  | How often weather comes |
| `fixture.grid_width, fixture.grid_height` | integers | No |  | A synthetic grid in place of a map |

```json
{
  "seed": "10775",
  "playback_duration_seconds": 3600,
  "map": {
    "osm_file": "data/fixtures/real_network.osm.xml"
  }
}
```

This is the one thing that takes the operator's credential alone, since it chooses files and directories.

Response `202`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "accepted": true,
    "lifecycle": "PREPARING",
    "seed": "10775",
    "seed_hex": "0x00000000000000000000000000002a17"
  },
  "ok": true,
  "run_id": "",
  "legacy": {
    "message": "This is the legacy API. It still works, but it will not gain new features: please switch t…",
    "use": "/api/v1/fabric/engine/start"
  }
}
```

Errors: `403 CLI_START_REQUIRED` without the credential; `400` for a bad value; `409 LIFECYCLE_CONFLICT` if a run is already being prepared; `503 MAP_FETCH_FAILED` if the map can't be downloaded.

### `POST /api/v1/fabric/engine/prepare`

Builds a world as `start` does, and doesn't begin playing. Takes the same fields, and answers when the world is ready.

**Who:** The operator (`X-DSTNS-Operator`).

### `GET /api/v1/fabric/engine/status`

Lifecycle, clock, seed, rate and configuration. `lifecycle` is one of `IDLE`, `PREPARING`, `READY`, `RUNNING`, `PAUSED`, `SEEKING`, `COMPLETED`, `TERMINATING`; see [lifecycle](lifecycle.md). While `PREPARING`, `data.eta_s` is how many seconds the world will take, and `data.eta_confident` whether that rests on something measured (a download of known size, a city on disk, the build) rather than on how long the last ones took; both are `null` and `false` otherwise. The same applies to `/api/v1/playback/status`.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "RUNNING",
    "simulated_current_time": "00:00:00",
    "simulation_percentage": 0.0,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 0
  },
  "config_revision": 1,
  "data": {
    "checkpoint_count": 1,
    "day": 0,
    "engine": "core-legacy",
    "lifecycle": "RUNNING",
    "map_selection_version": "urban-crfg-v3",
    "modules": {
      "buildings": true,
      "dws": true,
      "flooding": true,
      "news": true,
      "signals": true,
      "traffic": true
    },
    "observer_hold": false,
    "paused": false,
    "playback_revision": 3,
    "preparation_error": "",
    "run_id": "run_f104c50a105b",
    "saved_seed_id": "",
    "simulated_seconds": 0,
    "traffic_model": "DSTNS aggregate traffic model",
    "virtual_seconds_remaining": 86400
  },
  "global_seed": "0x00000000000000000000000000002a17",
  "ok": true,
  "run_id": "run_f104c50a105b",
  "seed": "10775",
  "state_revision": 0
}
```

### `POST /api/v1/fabric/engine/pause`

Holds the clock.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `expected_playback_revision` | integer | No | Non-negative | Only act if nobody else has changed playback since. If they have: `409` |

Response `200`, from a real run:

```json
{
  "changed": true,
  "lifecycle": "PAUSED",
  "ok": true,
  "playback_revision": 4,
  "run_id": "run_f104c50a105b",
  "simulated_seconds": 0,
  "state_revision": 0
}
```

Errors: `409` with a stale revision, or nothing to pause.

### `POST /api/v1/fabric/engine/play`

Carries on.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `expected_playback_revision` | integer | No | Non-negative | Only act if nobody else has changed playback since. If they have: `409` |

Response `200`, from a real run:

```json
{
  "changed": true,
  "lifecycle": "RUNNING",
  "ok": true,
  "simulated_seconds": 0
}
```

Errors: `409` if the run can't play from where it is.

### `POST /api/v1/fabric/engine/seek`

Jumps to a moment of the day, forward or back, by replaying from a checkpoint. Results are the same as having got there by playing.

The answer comes once the jump has landed, but the server keeps answering everything else while it is worked out:
`status` reads `SEEKING` with the clock moving towards the target. Another jump forward sent meanwhile sends the one
under way on to the new time and answers at once with `"redirected": true`; a step, or a jump backward, is refused
with `409` until it lands. A pause, a reset or a new world meanwhile stops the jump where it is, and it answers
`409`. A jump of half an hour or more lands [Restricted](../concepts/backpressure.md#long-jumps).

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `target_time` | seconds or `HH:MM:SS` | Yes | 0 to 86400 | Where to go |
| `play` | boolean | No | Default false | Play on arriving |

```json
{
  "target_time": "08:00:00",
  "play": false
}
```

Response `200`, from a real run:

```json
{
  "lifecycle": "RUNNING",
  "ok": true,
  "simulated_seconds": 28800,
  "state_revision": 28800,
  "target_time": "08:00:00"
}
```

Errors: `400 MISSING_FIELD`, `400` out of range; `409` with no run.

### `POST /api/v1/fabric/engine/step`

Advances by a fixed amount of simulated time, and holds there.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `seconds` | integer | No | 1 to 3600. Default 60 | How far |

```json
{
  "seconds": 60
}
```

Response `200`, from a real run:

```json
{
  "from_seconds": 28823,
  "lifecycle": "PAUSED",
  "ok": true,
  "playback_revision": 9,
  "simulated_seconds": 28883,
  "state_revision": 28883,
  "stepped_seconds": 60,
  "target_time": "08:01:23"
}
```

Errors: `400` out of range.

### `POST /api/v1/fabric/engine/reset`

Back to the start of the day, with the same world and seed.

**Who:** The observer or the operator.

### `POST /api/v1/fabric/engine/stop`

Ends the run. The server keeps running.

**Who:** The observer or the operator.

### `PUT /api/v1/fabric/engine/tick-rate`

Sets the speed. Under load, [adaptive backpressure](../concepts/backpressure.md) may apply less than this, and says so. Results for a seed don't depend on the rate.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `tick_rate` | number | Yes | Above 0, up to 10 | Speed multiplier |

```json
{
  "tick_rate": 2
}
```

Response `200`, from a real run:

```json
{
  "base_rate": 24.0,
  "command_id": 1,
  "ok": true,
  "previous_tick_rate": 1.0,
  "rate_governed_by_asb": false,
  "requested_tick_rate": 1.0,
  "target_virtual_rate": 24.0,
  "tick_rate": 1.0
}
```

Errors: `400` out of range.

### `POST /api/v1/fabric/engine/day`

Switches between a weekday and a weekend, which changes demand. **This changes results.**

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `day` | integer | Yes | 0 weekday, 1 weekend | Which |

```json
{
  "day": 0
}
```

Response `200`, from a real run:

```json
{
  "command_id": 2,
  "config_revision": 3,
  "day": 0,
  "ok": true,
  "previous_day": 0
}
```

### `PUT /api/v1/fabric/engine/modules/{module}`

Turns a subsystem on or off: `traffic`, `signals`, `buildings`, `dws`, `flooding` or `news`. **This changes results.** `POST .../modules/{module}/enable` and `/disable` do the same.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | Yes |  | On or off |

```json
{
  "enabled": true
}
```

Response `200`, from a real run:

```json
{
  "command_id": 3,
  "config_revision": 4,
  "enabled": true,
  "module": "news",
  "ok": true,
  "previous_enabled": true
}
```

Errors: `400` for an unknown module.

### `POST /api/v1/fabric/engine/events/weather`

Starts rain at a junction, which can flood roads nearby. **This changes results.** Answers `202`, since it's scheduled.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `epicenter_node` | integer | Yes | A junction in this world | Where it centres |
| `intensity` | number | No | 0 to 1. Default 0.85 | How hard |
| `radius_m` | number | No | Above 0. Default 350 | How wide |
| `duration_virtual_minutes` | number | No | 1 to 1440. Default 60 | How long, in simulated minutes |
| `flood_gain` | number | No | Default 0.5 | How readily it floods |

```json
{
  "epicenter_node": 5,
  "intensity": 0.8,
  "radius_m": 400,
  "duration_virtual_minutes": 30
}
```

Response `202`, from a real run:

```json
{
  "command_id": 4,
  "delayed_by_dws_gate": false,
  "effective_start_playback_s": 1203.4583333333333,
  "event_id": 1000000,
  "ok": true,
  "requested_start_playback_s": 1203.4583333333333,
  "status": "scheduled"
}
```

Errors: `400 unknown epicenter node`, `400 invalid weather parameters`.

### `POST /api/v1/fabric/engine/events/traffic`

Puts pressure on one road. **This changes results.**

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `target.type` | string | Yes | Only `edge` | What |
| `target.id` | integer | Yes | A road in this world | Which |
| `congestion_pressure` | number | Yes | 0 to 1 | How much. Capacity becomes \(1 - 0.75p\) |

```json
{
  "target": {
    "type": "edge",
    "id": 3
  },
  "congestion_pressure": 0.6
}
```

Response `202`, from a real run:

```json
{
  "command_id": 5,
  "edge_id": 3,
  "ok": true,
  "state_revision": 28884
}
```

### `POST /api/v1/fabric/engine/events/surge`

A burst of demand around a junction. **This changes results.**

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `node_id` | integer | Yes | A junction in this world | Where |
| `factor` | number | No | Above 0, up to 10. Default 1.8 | How much more |
| `radius_m` | number | No | Above 0, up to 20000. Default 350 | How wide |
| `duration_s` | integer | No | 1 to 86400. Default 1800 | How long |

```json
{
  "node_id": 5,
  "factor": 2,
  "radius_m": 300,
  "duration_s": 900
}
```

Response `202`, from a real run:

```json
{
  "end_time": "08:16:23",
  "factor": 2.0,
  "node_id": 5,
  "ok": true,
  "radius_m": 300.0,
  "start_time": "08:01:23",
  "surge_id": 1000001
}
```

### `PUT /api/v1/fabric/engine/edges/{id}`

Overrides one road. **This changes results.** `POST .../edges/{id}/override` is the same.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `speed_multiplier` | number | No | 0 to 2. Default 1 |  |
| `capacity_multiplier` | number | No | 0 to 2. Default 1 |  |
| `closed` | boolean | No | Default false | Closes it |

```json
{
  "speed_multiplier": 0.5,
  "closed": false
}
```

Response `200`, from a real run:

```json
{
  "command_id": 6,
  "edge_id": 3,
  "ok": true,
  "state_revision": 28885
}
```

Errors: `400 unknown edge`, `400` for multipliers out of range.

### `POST /api/v1/fabric/engine/signals/{id}`

Toggles the phase of the signal at a junction. `POST .../signals/{id}/toggle` is the same. **This changes results.**

**Who:** The observer or the operator.

Errors: `400 invalid node for signal toggle`.

### `POST /api/v1/fabric/engine/undo`

Undoes control actions, and `POST .../redo` does them again.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `count` | integer | No | 1 to 10000. Default 1 | How many |

```json
{
  "count": 1
}
```

Response `200`, from a real run:

```json
{
  "ok": true,
  "redo_depth": 1,
  "undo_depth": 5,
  "undone": [
    6
  ]
}
```

### `GET /api/v1/fabric/engine/history`

What's been done to the run, with what can be undone.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "commands": [
      {
        "command_id": 1,
        "status": "applied",
        "type": "tick_rate",
        "undoable": true,
        "virtual_day_s": 28883
      },
      {
        "command_id": 2,
        "status": "applied",
        "type": "day",
        "undoable": true,
        "virtual_day_s": 28883
      },
      "… and 4 more"
    ],
    "redo_depth": 1,
    "undo_depth": 5
  },
  "global_seed": "0x00000000000000000000000000002a17",
  "ok": true,
  "run_id": "run_f104c50a105b",
  "seed": "10775",
  "state_revision": 28886
}
```

## Reading the world

All open to read.

### `GET /api/v1/view/topology`

The world: junctions, roads with their shapes, places, projection and bounds. Large, and cached per world, so it's cheap to ask for. Also at `/api/v1/topology`, `/api/v1/view/network` and `/api/v1/view/map/full`.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "bounds": {
      "max_lat": 52.5286707,
      "max_lon": 13.4104259,
      "min_lat": 52.5112313,
      "min_lon": 13.3796531
    },
    "edges": [
      {
        "free_speed_mps": 16.67,
        "from": 330,
        "geometry": [
          {
            "lat": 52.5189326,
            "lon": 13.4026366,
            "x_m": 494.72352004689367,
            "y_m": -83.98833385603467
          },
          {
            "lat": 52.5186925,
            "lon": 13.4020194,
            "x_m": 452.91626062785326,
            "y_m": -110.7162658559443
          }
        ],
        "id": 0,
        "lanes": 2,
        "length_m": 49.620855384835274,
        "name": "Karl-Liebknecht-Straße",
        "reverse_twin": 1,
        "road_class": "primary",
        "synthetic_reverse": false,
        "tags": {
  … (shortened)
```

### `GET /api/v1/view/snapshot`

The state of every junction and road at this moment. It's what the observer polls. Fields for a road: `congestion` 0 to 1, `rainfall`, `flood`, `mean_speed_mps`, `effective_speed_mps`, `vehicle_count`, `halting_count`, `closed`, `incident_closed`, `incident_speed_multiplier`, `signal_multiplier`, `demand_vph`, `effective_capacity_vph`, `demand_causes`.

Query: `causes`, at most this many of each road's `demand_causes`, which are most of a snapshot's bytes. The observer
asks for 3, the number it shows. Without it, every cause is listed.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "active_incidents": [
      {
        "capacity_multiplier": 0.6,
        "closed": false,
        "congestion": 0.5299996765147529,
        "description": "Commercial transit vehicle breakdown obstructing right lane",
        "edge_id": 1416,
        "effective_speed_mps": 4.5815,
        "end_virtual_s": 29614,
        "flood": 0.0,
        "from_node": 527,
        "incident_id": 1,
        "node_id": 527,
        "remaining_s": 731,
        "road_class": "residential",
        "speed_multiplier": 0.55,
        "start_virtual_s": 28048,
        "to_node": 531,
        "type": "vehicle_breakdown",
        "vehicle_count": 1
      }
    ],
    "active_surges": [
      {
        "end_s": 29783,
        "factor": 1.0,
        "id": 1000001,
        "label": "Commercial Demand Surge",
        "lat": 52.5183473,
        "lon": 13.4070094,
        "node_id": 5,
        "radius_m": 105.0,
  … (shortened)
```

### `GET /api/v1/view/global`

Topology and snapshot together. Also at `/view/world`, `/view/all` and `/view/global.json`.

**Who:** Anyone who can reach the port.

### `GET /api/v1/view/nodes`

Junctions, a page at a time. `/api/v1/view/nodes/{id}` is one, or `404`.

**Who:** Anyone who can reach the port.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `offset` | integer | No | Default 0 |  |
| `limit` | integer | No | Default 250, at most 1000 |  |

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "items": [
      {
        "building": null,
        "degree": 5,
        "id": 0,
        "osm_node_id": 20246257,
        "position": {
          "lat": 52.5156494,
          "lon": 13.3890366,
          "x_m": -426.4993057792951,
          "y_m": -449.4741578558663
        },
        "roles": {
          "building": false,
          "bus_stop": false,
          "signal": false
        },
        "weather": {
          "drainage": 0.6417057882412337,
          "flood": 0.0,
          "flood_susceptibility": 0.5846999818051699,
          "rainfall": 0.0
        }
      },
      {
        "building": null,
        "degree": 2,
        "id": 1,
        "osm_node_id": 21487161,
        "position": {
          "lat": 52.5238544,
          "lon": 13.387467,
  … (shortened)
```

### `GET /api/v1/view/edges`

Directed roads, a page at a time. `/api/v1/view/edges/{id}` is one, or `404`.

**Who:** Anyone who can reach the port.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `offset` | integer | No | Default 0 |  |
| `limit` | integer | No | Default 250, at most 1000 |  |

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "items": [
      {
        "control": {
          "closed": false,
          "manual_capacity_multiplier": 1.0,
          "manual_speed_multiplier": 1.0
        },
        "from": 330,
        "id": 0,
        "reverse_twin": 1,
        "road": {
          "base_capacity_vph": 3200.0,
          "class": "primary",
          "free_speed_mps": 16.67,
          "lanes": 2,
          "length_m": 49.620855384835274
        },
        "source": {
          "osm_way_id": 4067932,
          "synthetic_reverse": false
        },
        "to": 459,
        "traffic": {
          "congestion": 0.14070502374586014,
          "demand_vph": 3347.728691200593,
          "effective_capacity_vph": 3198.9925823138547,
          "effective_speed_mps": 16.6651893182003,
          "halting_count": 0,
          "mean_speed_mps": 13.390646898641155,
          "occupancy": 0.15114612478631495,
          "vehicle_count": 3
        },
  … (shortened)
```

### `GET /api/v1/view/places`

Classified places with what the demand model believes about each. Also at `/api/v1/places`.

**Who:** Anyone who can reach the port.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `kind` | string | No | `[a-z_]{1,32}` | One kind only |
| `offset` | integer | No | Default 0 |  |
| `limit` | integer | No | Default 500, at most 2000 |  |

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "items": [
      {
        "anchor_node": 182,
        "category": "library",
        "commercial": false,
        "demand": {
          "baseline": 1.0,
          "factors": [],
          "multiplier": 1.0,
          "radius_m": 400.0
        },
        "generator": false,
        "id": "node/1070809009",
        "kind": "culture",
        "modelled": true,
        "name": "Zweigbibliothek Klassische Archäologie",
        "polygon": false,
        "position": {
          "lat": 52.5182172,
          "lon": 13.3929002,
          "x_m": -164.79073887771392,
          "y_m": -163.62666185571697
        },
        "tags": {
          "addr:city": "Berlin",
          "addr:country": "DE",
          "addr:housenumber": "6",
          "addr:postcode": "10117",
          "addr:street": "Unter den Linden",
          "addr:suburb": "Mitte",
          "amenity": "library",
          "email": "archaeologie@ub.hu-berlin.de",
  … (shortened)
```

### `GET /api/v1/view/place-kinds`

Every kind of place, with this world's counts.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "items": [
      {
        "commercial": false,
        "count": 22,
        "generator": true,
        "kind": "school",
        "modelled": true
      },
      {
        "commercial": false,
        "count": 23,
        "generator": true,
        "kind": "university",
        "modelled": true
      },
      "… and 16 more"
    ],
    "stop_spacing_m": 300.0
  },
  "global_seed": "0x00000000000000000000000000002a17",
  "ok": true,
  "run_id": "run_f104c50a105b",
  "seed": "10775",
  "state_revision": 28886
}
```

### `GET /api/v1/view/stops`

Bus stops: the same as `/view/places?kind=bus_stop`.

**Who:** Anyone who can reach the port.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `offset` | integer | No | Default 0 |  |
| `limit` | integer | No | Default 500, at most 2000 |  |

### `GET /api/v1/view/{catalog}`

A focused view of one thing, where `catalog` is `traffic`, `weather`, `buildings`, `bus-stops`, `signals`, `events`, `metrics`, `incidents` or `congestion`.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "average": 29.454953074222576,
    "current": 30.340251084874197,
    "delta": 0.8852980106516206,
    "ema_tau_virtual_s": 900,
    "history": [
      {
        "average": 0.0,
        "current": 0.0,
        "virtual_s": 1
      },
      {
        "average": 0.316940538551288,
        "current": 5.555821988301121,
        "virtual_s": 60
      },
      "… and 480 more"
    ],
    "source": "DSTNS aggregate traffic model",
    "weighting": "edge length × lanes; traversable directions only"
  },
  "global_seed": "0x00000000000000000000000000002a17",
  "ok": true,
  "run_id": "run_f104c50a105b",
  "seed": "10775",
  "state_revision": 28886
}
```

### `GET /api/v1/view/run`

The run's status, as is `/api/v1/view/config`.

**Who:** Anyone who can reach the port.

### `GET /api/v1/view/manifest`

What identifies this world: map selection, algorithms and hashes, for reproducing it. Since API 1.8 it also has
`network`: `source`, `nodes`, `edges`, `features` (counts) and `location` (`city`, `country`, `downloaded`), as
`/api/v1/view/topology` says, in a few hundred bytes. A client that needs only these should read them here.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "algorithm_version": "DSTNS/1",
    "determinism_level": 2,
    "event_hash": "sha256:fdc9a33b353e31beda2558317c41a4ab25862fa55e152929ec59188721ab295a",
    "graph_hash": "sha256:c89c19f7842544fbb6329bbc7899c7da8408e0de76e12b17e183ea8467fc743b",
    "map_hash": "sha256:3b6397c089e41f7874b196d830b1bca05ce91ae3c92cf1010c735609dbd89363",
    "map_source": "osm-xml",
    "product": "DSTNS",
    "road_filter_version": "road-only/v1",
    "scenario_hash": "sha256:f104c50a105b019845b9e87f2eae5dc788f17534068bfe87915a08b294b389d9",
    "seed": "10775",
    "seed_hex": "0x00000000000000000000000000002a17",
    "version": "1.0.0"
  },
  "global_seed": "0x00000000000000000000000000002a17",
  "ok": true,
  "run_id": "run_f104c50a105b",
  "seed": "10775",
  "state_revision": 28886
}
```

### `GET /api/v1/view/event-queue`

Events scheduled or done.

**Who:** Anyone who can reach the port.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `view` | string | No | `future` or `history`. Default `future` |  |
| `category` | string | No | `all`, `signals`, `demand`, `incidents`, `weather`, `flooding`, `system` |  |
| `offset` | integer | No | At most 100000 |  |
| `limit` | integer | No | 1 to 200. Default 50 |  |

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "executed_count": 112549,
    "history_retention": 2000,
    "items": [
      {
        "category": "signals",
        "description": "Signal 20 → A amber",
        "entity": 9,
        "id": 123833,
        "phase": 1,
        "status": "scheduled",
        "value": 0.0,
        "virtual_s": 28884
      }
    ],
    "limit": 1,
    "offset": 0,
    "pending_count": 11407,
    "total": 11407
  },
  "global_seed": "0x00000000000000000000000000002a17",
  "ok": true,
  "run_id": "run_f104c50a105b",
  "seed": "10775",
  "state_revision": 28886
}
```

### `GET /api/v1/news`

The operator's news feed. See [news](news-api.md).

**Who:** Anyone who can reach the port.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `since_news_id` | integer | No | Default 0 | Only newer |
| `limit` | integer | No | At most 500. Default 100 |  |
| `since_narration` | integer | No | Default 0 | Only newer wording |
| `narration` | string | No | `realistic` | Include the narrator's wording |

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "clock": {
    "base_rate": 24.0,
    "playback_duration_seconds": 3600,
    "playback_state": "PAUSED",
    "simulated_current_time": "08:01:23",
    "simulation_percentage": 0.3342939814814815,
    "target_virtual_rate": 24.0,
    "tick_rate": 1.0,
    "virtual_day_seconds": 28883
  },
  "config_revision": 5,
  "data": {
    "items": [
      {
        "category": "system",
        "data": {
          "scenario_hash": "sha256:f104c50a105b019845b9e87f2eae5dc788f17534068bfe87915a08b294b389d9"
        },
        "event_id": 0,
        "message": "[00:00:00] Scenario initialized with Seed 0x00000000000000000000000000002a17",
        "news_id": 1,
        "severity": "info",
        "simulated_current_time": "00:00:00",
        "template_id": "SCENARIO_INITIALIZED",
        "virtual_day_s": 0
      }
    ]
  },
  "global_seed": "0x00000000000000000000000000002a17",
  "ok": true,
  "run_id": "run_f104c50a105b",
  "seed": "10775",
  "state_revision": 28886
}
```

### `GET /api/v1/view/logs/system`

The latest 250 lines of the system log. `/view/logs/events` and `/view/logs/api` take a `limit` of up to 1000.

**Who:** Anyone who can reach the port.

### `GET /api/v1/view/stream`

One snapshot as a server-sent event, then close, with `retry: 1000`. `/api/v1/news/stream` is the same for news. See [streaming](streaming.md).

**Who:** Anyone who can reach the port.

## The system

### `GET /health`

Is it alive? Also at `/api/v1/system/health`.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "lifecycle": "PAUSED",
  "observer_ui_version": "observer-v2",
  "ok": true,
  "product": "Deterministic Spatiotemporal Transport Network Simulator",
  "service": "dstns",
  "version": "3.10.0"
}
```

### `GET /api/v1/system/resources`

The server process's memory and processor time, and nothing else, so it is cheap to ask for often: the observer
asks every few seconds and charts it in the report. `rss_bytes` is the memory held now, `peak_rss_bytes` the most
held since the server started, `cpu_s` the processor time used and `hardware_threads` how many the machine has.
`checkpoints` (API 1.9) gives how many checkpoints the run keeps and the bytes they hold; core-ng keeps them deflated.

**Who:** Anyone who can reach the port.

Response `200`:

```json
{
  "checkpoints": {"count": 96, "bytes": 362496},
  "hardware_threads": 10,
  "ok": true,
  "process": {
    "cpu_s": 12.4,
    "peak_rss_bytes": 286261248,
    "pid": 48211,
    "rss_bytes": 272629760,
    "uptime_s": 95.2
  }
}
```

### `GET /api/v1/engine`

The running engine and every installed one, with the engine policy (config/engines.json) and the approval. See
[Engine governance](../design/engine-governance.md).

```json
{"ok": true, "data": {
  "running": {"id": "core-ng", "version": "1.0.0", "kind": "real", "channel": "stable", "owns": ["…"], "shared": ["physics step", "…"], "changes": ["…"]},
  "catalogue": [{"id": "core-legacy", "version": "3.10.0", "kind": "real", "channel": "stable"}, {"id": "core-ng", "…": "…"}],
  "config": {"schema_version": 1, "selected": "core-legacy", "default": "core-legacy", "auto_switch": "offer", "engines": {"core-ng": {"enabled": true, "acknowledgment": {"ui": true, "enforce": true}}}},
  "approval": {"state": "none", "revision": 0}}}
```

### `GET /api/v1/engine/approval`

Whether a start waits for acknowledgment. Only an alpha or beta engine's runs wait; no installed engine is one today, so
the example marks core-ng beta, as `DSTNS_ENGINE_CHANNEL=core-ng=beta` does. `state` is `none`, `pending`, `accepted`, `rejected` or `cancelled`;
`revision` increases with each change. With a start waiting or rejected, `approval` names it and `alternatives` lists
the enabled stable real engines a rejection may start the seed on (empty when `auto_switch` is `off`).

```json
{"ok": true, "data": {"state": "pending", "revision": 3,
  "approval": {"id": "9f1c…", "engine": {"id": "core-ng", "version": "1.0.0", "channel": "beta", "kind": "real"}, "seed": "42",
               "requested_at": "2026-11-13T18:00:00Z", "acknowledge_in": "observer", "decision": "", "then": "", "reason": ""},
  "alternatives": [{"id": "core-legacy", "version": "3.10.0", "channel": "stable", "kind": "real"}]}}
```

### `GET /api/v1/engine/approval/wait`

A long poll for clients that were told to wait: returns as soon as `revision` is past `since`, or after `timeout`
seconds (default 25, at most 30), with the same body as `GET /api/v1/engine/approval`.

### `POST /api/v1/engine/approval`

Accept or reject a start that waits, from the observer (`X-DSTNS-Host`) or the operator. When the engine's
acknowledgment is set to the launcher, only the operator may decide (`403 ACKNOWLEDGE_IN_LAUNCHER`).

```json
{"approval_id": "9f1c…", "decision": "reject", "then": "regenerate", "engine": "core-legacy"}
```

`accept` runs the held start, once. `reject` starts nothing, or with `then: "terminate"` ends the server, or with
`then: "regenerate"` starts the same seed, and only the seed, on `engine` (one of the alternatives): a new world,
which may differ from the one the rejected engine would have made. The same decision again returns the same answer.

Errors: `400 BAD_DECISION`, `400 ENGINE_NOT_OFFERED`, `401 AUTHORIZATION_REQUIRED`, `403 ACKNOWLEDGE_IN_LAUNCHER`,
`404 APPROVAL_NOT_FOUND`, `409 APPROVAL_DECIDED`.

### `GET /api/v1/system/info`

Version, build, the server process, and whether SUMO is available. `process` is the server
itself: `pid`, `uptime_s`, `rss_bytes` (the memory it holds now), `peak_rss_bytes` (the most
it has held) and `cpu_s` (processor time used). The launcher's dashboard, `ps`, `uptime` and the prompt's live
readings come from it.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "build": {
    "architecture": "arm64",
    "channel": "local",
    "compiler": "Apple LLVM 21.0.0 (clang-2100.3.34.2)",
    "cpp_standard": 202002,
    "created": "unknown",
    "revision": "unknown",
    "type": "Release"
  },
  "lifecycle": "PAUSED",
  "ok": true,
  "process": {
    "cpu_s": 41.73,
    "peak_rss_bytes": 224395264,
    "pid": 48211,
    "rss_bytes": 201457664,
    "uptime_s": 751.4
  },
  "product": "Deterministic Spatiotemporal Transport Network Simulator",
  "service": "dstns",
  "sumo": {
    "enabled": true,
    "available": false,
    "netconvert_binary": "/Users/varun/sumo/bin/netconvert",
    "sumo_binary": "/Users/varun/sumo/bin/sumo",
    "sumo_home": "/Users/varun/sumo",
    "version": ""
  },
  "version": "3.10.0"
}
```

### `GET /api/v1/system/status`

The full run status.

**Who:** Anyone who can reach the port.

### `GET /api/v1/system/endpoints`

An index of the API, from the API. Also at `/api/v1`.

**Who:** Anyone who can reach the port.

### `GET /api/v1/system/map-status`

What's being downloaded or prepared.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "active": false,
    "bytes": 0,
    "city": "",
    "country": "",
    "elapsed_s": 0.0,
    "phase": "",
    "preparation": "",
    "total": 0
  },
  "ok": true
}
```

### `GET /api/v1/system/source`

The source offer under AGPL-3.0 section 13.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "copyright": "Copyright (C) 2026 Varun Karthic",
    "license": "AGPL-3.0-or-later",
    "license_url": "https://www.gnu.org/licenses/agpl-3.0.html",
    "map_data": {
      "license": "ODbL 1.0",
      "source": "OpenStreetMap contributors",
      "url": "https://www.openstreetmap.org/copyright"
    },
    "program": "DSTNS",
    "source_offer": "You may obtain the complete corresponding source for this running version, under the terms…",
    "version": "3.10.0"
  },
  "ok": true
}
```

### `GET /api/v1/system/ui-config`

The operator's defaults for the interface, from `config/ui-config.json`.

**Who:** Anyone who can reach the port.

Errors: `500 UI_CONFIG_INVALID` if that file isn't valid JSON.

### `GET /api/v1/system/backpressure`

[Adaptive backpressure](../concepts/backpressure.md): score, state, rate and what it has done.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "actions": [],
  "applied_tick_rate": 1.0,
  "gui_suspended": false,
  "motion_locked": false,
  "observer_away": false,
  "ok": true,
  "rate_cap": 0.0,
  "rate_capped": false,
  "rate_locked": false,
  "raw_score": 0.0,
  "requested_tick_rate": 1.0,
  "restriction": "",
  "score": 0.0,
  "state": "NORMAL",
  "state_for_s": 10.058781291,
  "stressed_for_s": 0.0,
  "synced": true,
  "thresholds": {
    "critical": 0.85,
    "escalate_after_s": 3.0,
    "recover_after_s": 3.0,
    "restricted_hold_s": 5.0,
    "stressed": 0.6,
    "synced": 0.35
  },
  "throughput": {
    "bytes_per_s": 24390252.904416285,
    "snapshots_per_s": 16.77641236421584
  }
}
```

### `POST /api/v1/system/backpressure`

The observer reports how it's keeping up, and the answer is what to do about it.

**Who:** Anyone who can reach the port, from the observer in practice.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `virtual_lag_s` | number | No | Not negative | Simulated seconds behind |
| `client_frame_s` | number | No | Not negative | Seconds per frame |
| `since_poll_s` | number | No | Not negative | Seconds since it last polled |
| `away` | boolean | No |  | The page is hidden, so judge nothing |

```json
{
  "virtual_lag_s": 0.2,
  "client_frame_s": 0.016,
  "since_poll_s": 0.5
}
```

### `GET /api/v1/system/observer`

How many times the observer has been loaded. `POST` with `{"waiting": true}` says an open observer is still showing its start-up, so a finished world should wait. Silence for a few seconds counts as having gone.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "loaded": false,
    "loads": 0
  },
  "ok": true
}
```

### `GET /api/v1/system/narrator`

The narration model, queue and cache.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "data": {
    "backend": {
      "command": "/usr/bin/fm serve",
      "endpoint": "unix:/var/folders/vq/tb738dm976z76f7ngp9r_lhh0000gn/T/dstns-fm-96864.sock",
      "kind": "apple-foundation-models",
      "model": "system",
      "on_device": true
    },
    "brand": "Realistic News",
    "cache": {
      "capacity": 4096,
      "entries": 3,
      "path": "logs/narrations.db",
      "persistent": true
    },
    "cache_hits": 1,
    "completed": 3,
    "dropped": 0,
    "enabled": true,
    "failed": 0,
    "in_flight": 2,
    "last_error": "",
    "latency_ms": {
      "max": 6751.848916,
      "mean": 5317.451930333333
    },
    "live_queue": 130,
    "prefetch_queue": 18,
    "queue": 148,
    "refused": 0,
    "requested": 282,
    "role": "presentation only: narrations never feed back into the simulation, and the API serves them…",
    "sequence": 3,
    "state": "ready"
  },
  "ok": true
}
```

### `GET /api/v1/system/features`

What the operator has turned on and off for this server, and how the observer should present itself. It's set by whoever starts the server, through the launcher's settings or [environment variables](../reference/environment-variables.md#fabric-and-presentation), and nothing can change it while the server runs.

`presentation` holds `webfabric`, `force_animate`, `fast_boot`, `demo`, `music`, `music_track` (the server has a music file of the operator's own to play, from [`GET /api/v1/system/music`](#get-apiv1systemmusic)), `fullscreen` and `music_volume`, and how hard the observer works: `map_fps` (0 lets the map decide, or 60 or 30), `render_scale` (0.5 to 3) and `film_particles` (4,000 to 32,000). With `fast_boot`, `force_animate` is always false. `performance` reports the server's own: `compression`, `api_threads` and `engine_threads`.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "applications": true,
    "disabled_capabilities": [],
    "launch_proposals": true,
    "legacy_api": true,
    "presentation": {
      "demo": false,
      "fast_boot": false,
      "force_animate": true,
      "fullscreen": false,
      "music": false,
      "music_volume": 0.6,
      "webfabric": true
    },
    "require_signatures": false,
    "world_regeneration": true
  },
  "ok": true
}
```


### `GET /api/v1/system/music`

The film's music, when the operator chose a file of their own: the MP3, M4A or WAV named by
`DSTNS_MUSIC_FILE` when the server started (the launcher sets it from `presentation.music_file`
or `demo.music_file`), up to 64 MB, as `audio/mpeg`, `audio/mp4` or `audio/wav`. Range requests
are answered with `206`, so the page can loop it. A request can't name a file: there is only the
one the server was started with.

**Who:** Anyone who can reach the port.

`404 NO_MUSIC_FILE` when none was chosen, or the file is missing, of another type or too large.

### `POST /api/v1/system/terminate`

Stops the simulation and exits the process. Also at `/terminate`. POST only, so that a link or an image can't do it.

**Who:** Anyone who can reach the port, except a page from another site.

### `POST /api/v1/export/sumo`

Writes the world as a SUMO bundle: `network.nod.xml`, `network.edg.xml`, `sandbox.rou.xml`, `sandbox.add.xml`, `sandbox.sumocfg`.

**Who:** Anyone who can reach the port, except a page from another site.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `directory` | string | No | Under `data/`, unless you're the operator. Default `data/sumo_export` | Where |

```json
{
  "directory": "data/sumo_export"
}
```

Errors: `403 SUMO_DISABLED` when SUMO is turned off (`DSTNS_SUMO=0`); `403 DIRECTORY_NOT_ALLOWED`; `409` with no run; `503 SUMO_FAILED` if it can't be written.

### `POST /api/v1/system/sumo-simulate`

Exports, builds and runs SUMO as a batch job. See the [SUMO adapter](../components/sumo-adapter.md).

**Who:** Anyone who can reach the port, except a page from another site.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `directory` | string | No | As above. Default `data/sumo_run` |  |
| `begin_s` | seconds or `HH:MM:SS` | No | Default 0 |  |
| `end_s` | seconds or `HH:MM:SS` | No | After `begin_s`, up to 86400. Default 3600 |  |

Errors: `400` for the period; `403 SUMO_DISABLED` when SUMO is turned off; `403 DIRECTORY_NOT_ALLOWED`; `503 SUMO_FAILED`.

### `POST /api/v1/world/regenerate`

A new world, from a new seed from the secure generator (or the one [Dynamic Fastboot](../guide/fast-boot.md#dynamic-fastboot) prepared), with every other setting copied from the run the operator started. It can't choose anything else. `DSTNS_DISABLE_WORLD_REGENERATION=1` turns it off.

**Who:** Anyone who can reach the port, except a page from another site.

Body, all optional:

| Field | Type | Meaning |
|---|---|---|
| `expected_run_id` | string | Refuse with `409` if the current run is no longer this one |
| `stage` | boolean | Prepare it without replacing the current world, which keeps running. It waits in state `staged` for a commit or a discard |

Errors: `403 WORLD_REGENERATION_DISABLED`, `409 LIFECYCLE_CONFLICT`.

### `POST /api/v1/world/regenerate/commit`

Puts in the world prepared with `stage`: at once if it is ready, or as soon as it is. Like
any new world it starts paused at 00:00:00. The observer calls it when a person presses
**Generate**.

**Who:** As for regenerate. Errors: `403 WORLD_REGENERATION_DISABLED`, and `409` when no
world is waiting to be confirmed.

### `POST /api/v1/world/regenerate/discard`

Forgets the world prepared with `stage`. One still being prepared finishes, and is dropped.
The current world is untouched, and with nothing staged it does nothing.

**Who:** As for regenerate.

### `GET /api/v1/world/status`

How preparation is going, and any lasting error.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "elapsed_s": 0.0,
    "enabled": true,
    "error": null,
    "generation": 0,
    "map": null,
    "previous_run_id": "",
    "run_id": "",
    "seed": "",
    "seed_hex": "",
    "stage": "idle",
    "state": "idle",
    "eta_s": null,
    "eta_confident": false,
    "next": {
      "enabled": true,
      "state": "ready",
      "seed": "9021178532209915623",
      "city": "Lisbon",
      "country": "Portugal"
    }
  },
  "ok": true
}
```

`state` is `idle`, `generating`, `staged` (prepared and waiting to be confirmed), `ready` or
`failed`. While generating, `eta_s` is how many seconds the new world will take, and
`eta_confident` whether that rests on something measured; see
[the adaptive film](../guide/fast-boot.md#the-adaptive-film). `next` is Dynamic Fastboot's next
world: `state` is `idle`, `fetching`, `ready`, `failed` or `off`.

## Applications: joining

An application is any program. See [Building applications](../development/webfabric-apps.md) for how to write one.

In every route here, `{id}` is the application's ID. If it asked for signed requests, every route that takes its token also needs the [signature headers](security.md#signed-requests), or it gets `401 SIGNATURE_REQUIRED`.

Every route that takes a token can answer `401 APP_TOKEN_INVALID` and `404 APP_NOT_FOUND`. A route with a capability can answer `403 CAPABILITY_NOT_GRANTED`, and `409 APP_NOT_ACTIVE` if the application is suspended, has failed or has gone.

### `POST /api/v1/fabric/apps`

Registers from a manifest. It answers with a **token and a signing key, shown only this once**. Registering again with the token updates it. An ID that has gone can be taken up without the token unless a person gave it something, but the newcomer gets none of what the old one kept or was sent.

**Who:** Anyone who can reach the port. To update a registered application, its token. A process the launcher started may present `X-DSTNS-Launch-Key` in place of the token.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `id` | string | Yes | 3 to 64: lower case, digits, dots and hyphens. May not be `dstns`, `fabric` or `webfabric`, or start with them | Identity |
| `name` | string | Yes | Up to 40 bytes. Not `DSTNS`, `Fabric` or `WebFabric` | Shown to people |
| `version` | string | Yes | Up to 32: `1`, `1.2`, `1.2.3`, with a suffix | Its version |
| `description` | string | No | Up to 280 |  |
| `author` | string | No | Up to 80 |  |
| `requires_api` | integer | No | Must be 1 | What it needs, or `422 APP_INCOMPATIBLE` |
| `capabilities` | array | No | See [capabilities](security.md#capabilities) | What it asks for |
| `lease_s` | number | No | 1 to 3600. Default 60 | Check in this often, or be suspended. Five times this and it's gone |
| `ui` | array | No | Up to 64 elements, 4 MiB | What to show from the start |
| `settings` | object | No | Up to 128 fields | Its settings page |
| `frame_origins` | array | No | Up to 16 origins | The only places its pages may come from |
| `security.require_signatures` | boolean | No |  | Refuse unsigned requests from now on |
| `web.url` | string | No | http or https, up to 2000 | Its own web interface. The observer offers a button that opens it in a new tab |
| `web.label` | string | No | Up to 40 | What the button says |

```json
{
  "id": "org.example.planner",
  "name": "Planner",
  "version": "1.0.0",
  "description": "Plans a bus route.",
  "capabilities": [
    "ui.panels",
    "ui.status",
    "ui.overlays",
    "ui.notifications",
    "ui.camera",
    "ui.layers",
    "settings",
    "sim.read",
    "storage",
    "apps.messages",
    "control.playback"
  ],
  "lease_s": 60
}
```

Response `201`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "app": {
      "author": "",
      "blocked_ui": [],
      "capabilities": {
        "granted": [
          "apps.messages",
          "settings",
          "… and 6 more"
        ],
        "pending": [
          "ui.camera",
          "ui.layers",
          "… and 1 more"
        ],
        "requested": [
          "ui.panels",
          "ui.status",
          "… and 9 more"
        ]
      },
      "description": "Plans a bus route.",
      "detail": "",
      "id": "org.example.planner",
      "name": "Planner",
      "order": 0,
      "security": {
        "frame_origins": [],
        "signatures_required": false
      },
      "settings": null,
      "state": "registered",
      "ui": [],
      "user_suspended": false,
      "version": "1.0.0",
      "web": null
    },
    "signing_key": "(shown once)",
    "token": "(shown once)"
  },
  "ok": true
}
```

Errors: `400 INVALID_MANIFEST`; `403 APP_ID_RESERVED`, `403 APP_NAME_RESERVED`; `409 APP_ID_CONFLICT`; `422 APP_INCOMPATIBLE`, `422 NOT_ON_NETWORK`; `429 APP_LIMIT_REACHED` with 64 applications, none of which can make way.

### `GET /api/v1/fabric/apps`

Every application: its state, and what it has asked for and been given.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "items": [
      {
        "author": "",
        "capabilities": {
          "granted": [
            "apps.messages",
            "settings",
            "… and 6 more"
          ],
          "pending": [
            "ui.camera",
            "ui.layers",
            "… and 1 more"
          ],
          "requested": [
            "ui.panels",
            "ui.status",
            "… and 9 more"
          ]
        },
        "description": "Plans a bus route.",
        "detail": "",
        "id": "org.example.planner",
        "name": "Planner",
        "order": 0,
        "security": {
          "frame_origins": [],
          "signatures_required": false
        },
        "settings": null,
        "state": "registered",
        "user_suspended": false,
        "version": "1.0.0",
        "web": null
      }
    ]
  },
  "ok": true
}
```

### `GET /api/v1/fabric/apps/{id}`

One application.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "author": "",
    "blocked_ui": [],
    "capabilities": {
      "granted": [
        "apps.messages",
        "settings",
        "… and 6 more"
      ],
      "pending": [
        "ui.camera",
        "ui.layers",
        "… and 1 more"
      ],
      "requested": [
        "ui.panels",
        "ui.status",
        "… and 9 more"
      ]
    },
    "description": "Plans a bus route.",
    "detail": "",
    "id": "org.example.planner",
    "name": "Planner",
    "order": 0,
    "security": {
      "frame_origins": [],
      "signatures_required": false
    },
    "settings": null,
    "state": "registered",
    "ui": [],
    "user_suspended": false,
    "version": "1.0.0",
    "web": null
  },
  "ok": true
}
```

### `DELETE /api/v1/fabric/apps/{id}`

With the token, it leaves and keeps its identity. As the observer or operator, it's forgotten altogether, along with its grants and storage.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it, or the observer or operator.

### `POST /api/v1/fabric/apps/{id}/heartbeat`

Renews the lease. Any request with the token does too.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {},
  "ok": true
}
```

### `PUT /api/v1/fabric/apps/{id}/state`

Says how it's getting on.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `state` | string | Yes | `initialized`, `active`, `failed` |  |
| `detail` | string | No | Up to 280 bytes |  |

```json
{
  "state": "active"
}
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {},
  "ok": true
}
```

Errors: `409 APP_SUSPENDED`.

### `GET /api/v1/fabric/apps/{id}/health`

How it's doing, as the server sees it.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it, or the observer or operator.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "detail": "",
    "events": {
      "dropped": 0,
      "queued": 0,
      "sequence": 0
    },
    "id": "org.example.planner",
    "last_seen_s": 2.91e-07,
    "lease_lapses": 0,
    "lease_s": 60.0,
    "messages": {
      "received": 0,
      "sent": 0
    },
    "rate_limited": 0,
    "refused": 0,
    "requests": 3,
    "state": "active",
    "storage": {
      "bytes": 2,
      "keys": 0
    },
    "timers": 0,
    "topics": [],
    "ui": {
      "bytes": 2,
      "elements": 0
    },
    "uptime_s": 0.00236225
  },
  "ok": true
}
```

### `POST /api/v1/fabric/apps/{id}/credentials/rotate`

Replaces the token and signing key, in that moment. The answer is the only place the new ones appear. The application gets `credentials.rotated`.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it.

Not called here, since this page goes on to use the token. It answers `{"token": ..., "signing_key": ...}`.

### `PUT /api/v1/fabric/apps/{id}/launch`

Proposes how the launcher should start this application. It runs nothing: a person reads it and approves it at the launcher. See [starting programs](security.md#starting-programs).

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `commands` | array of strings | Yes | 1 to 8, each up to 1 KiB | What to run |
| `cwd, env, ready, timeout_s, restart` |  | No | As `./launcher apps add`. 16 KiB in all |  |

```json
{
  "commands": [
    "python3 planner.py"
  ],
  "ready": "fabric"
}
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "at_ms": 1793606530845,
    "id": "org.example.planner",
    "proposed_by": "application",
    "spec": {
      "commands": [
        "python3 planner.py"
      ],
      "ready": "fabric"
    }
  },
  "ok": true
}
```

Errors: `400 INVALID_LAUNCH`; `429 TOO_MANY_PROPOSALS` with 64 waiting.

## Applications: on screen

Elements are declared as data, and the observer draws them with its own components. Slots, widgets and overlay features are described in [Fabric](fabric-api.md#declaring-ui).

### `PUT /api/v1/fabric/apps/{id}/ui`

Replaces every element. `PUT .../ui/{element}` adds or updates one, and `DELETE .../ui/{element}` removes one. An element's capability follows its slot: `status` needs `ui.status`, `panel` needs `ui.panels`, and so on.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `(array)` | array | Yes | Up to 64 elements, 4 MiB | Each has an `id` of `[a-z0-9][a-z0-9_-]{0,39}`, and a `slot` |

```json
[
  {
    "id": "summary",
    "slot": "status",
    "label": "Fleet",
    "value": "12 buses",
    "tone": "ok"
  }
]
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {},
  "ok": true
}
```

Errors: `400 INVALID_ELEMENT`; `403 CAPABILITY_NOT_REQUESTED`, `403 FRAME_ORIGIN_NOT_DECLARED`; `404 ELEMENT_NOT_FOUND`; `413 UI_TOO_LARGE`; `422 NOT_ON_NETWORK` for junctions or roads that aren't in this world.

### `POST /api/v1/fabric/apps/{id}/ui/batch`

Changes several at once: all of it or none of it.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `upsert` | array | No |  | Elements to add or update |
| `remove` | array | No |  | IDs to remove |

```json
{
  "upsert": [
    {
      "id": "summary",
      "slot": "status",
      "label": "Fleet",
      "value": "13 buses"
    }
  ],
  "remove": []
}
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {},
  "ok": true
}
```

### `POST /api/v1/fabric/apps/{id}/notifications`

Sends a notification, attributed to the application, so it can't pose as DSTNS. Do Not Disturb still applies. 20 a second with a burst of 40.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it. **Capability:** `ui.notifications`.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `title` | string | Yes | Up to 120 bytes |  |
| `body` | string | No | Up to 600 bytes |  |
| `severity` | string | No | `info`, `warning`, `alert`. Default `info` |  |

```json
{
  "title": "Route ready",
  "severity": "info"
}
```

Response `202`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "sequence": 1
  },
  "ok": true
}
```

Errors: `400 INVALID_NOTIFICATION`; `429 RATE_LIMITED`.

### `POST /api/v1/fabric/apps/{id}/view`

Asks the map to move. It answers `202` with the request's number, since the observer hasn't seen it yet, and `view.applied` or `view.declined` follows as an event. Limits are in [security](security.md#directing-the-view). 2 a second with a burst of 4, shared with `presentation`, and a refused request also counts.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it. **Capability:** `ui.camera`.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `action` | string | Yes | `focus`, `node`, `edge`, `bounds`, `zoom`, `fit` |  |
| `x_m, y_m` | numbers | For `focus` | Within ±100,000 km | A point |
| `node` | integer | For `node` | In this world | A junction |
| `edge` | integer | For `edge` | In this world | A road |
| `span_m` | number | No | 10 to 10,000,000 | Metres to show across |
| `min_x_m, min_y_m, max_x_m, max_y_m` | numbers | For `bounds` | With an area | An area |
| `factor` | number | For `zoom` | 0.25 to 4 | Above 1 is closer |

```json
{
  "action": "node",
  "node": 5,
  "span_m": 800
}
```

Response `202`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "request": 1
  },
  "ok": true
}
```

Errors: `400 INVALID_VIEW`; `422 NOT_ON_NETWORK`; `429 RATE_LIMITED`.

### `PUT /api/v1/fabric/apps/{id}/presentation`

Holds layers and places on or off, over a person's choices and never in place of them. It replaces what was held, isn't saved, and ends with the application. `DELETE` lets go.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it. **Capability:** `ui.layers`.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `layers` | object | No | `traffic`, `weather`, `flooding`, `events`, `buildings`, `signals`, `roads`, `vehicles`, `incidents`, `labels`, `place_names`, `other_places`: true or false |  |
| `places` | object | No | Up to 64 kinds: true or false |  |

```json
{
  "layers": {
    "traffic": true,
    "weather": false
  },
  "places": {
    "school": false
  }
}
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "layers": {
      "traffic": true,
      "weather": false
    },
    "places": {
      "school": false
    }
  },
  "ok": true
}
```

Errors: `400 INVALID_PRESENTATION`; `429 RATE_LIMITED`.

## Applications: what they keep and hear

### `GET /api/v1/fabric/apps/{id}/events`

What has happened, oldest first, up to 200 at a time, holding the latest 1000. `dropped` says how many were missed.

Types: `ui.action` (a person used something), `settings.changed`, `settings.migrated`, `capabilities.changed`, `app.suspended`, `app.resumed`, `app.failed`, `credentials.rotated`, `view.applied`, `view.declined`, `message`, `timer`, and with a subscription, `lifecycle.changed`, `world.changed` and `news`.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `since` | integer | No | Default 0 | The last `sequence` you saw |

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "dropped": 0,
    "items": [
      {
        "at_ms": 1793606530845,
        "data": {
          "granted": [
            "apps.messages",
            "control.playback",
            "… and 9 more"
          ]
        },
        "sequence": 1,
        "type": "capabilities.changed"
      }
    ],
    "sequence": 1
  },
  "ok": true
}
```

### `PUT /api/v1/fabric/apps/{id}/subscriptions`

Chooses what of the simulation arrives as events.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it. **Capability:** `sim.read`.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `topics` | array | Yes | Up to 32 of `lifecycle`, `world`, `news`, `news.<category>` |  |

```json
{
  "topics": [
    "lifecycle",
    "news.incident"
  ]
}
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "topics": [
      "lifecycle",
      "news.incident"
    ]
  },
  "ok": true
}
```

Errors: `400 INVALID_TOPICS`.

### `PUT /api/v1/fabric/apps/{id}/timers/{timer}`

A timer on the simulation's clock, which means the same at any speed. `GET .../timers` lists them, and `DELETE .../timers/{timer}` clears one. `{timer}` is `[a-z0-9_-]+`.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it. **Capability:** `sim.read`.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `at_s` | number | Yes | Not negative | Simulated second |
| `every_s` | number | No | 0, or at least 1 | Repeat |
| `data` | any | No |  | Comes back with the event |

```json
{
  "at_s": 28800,
  "every_s": 3600
}
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "at_s": 28800.0,
    "every_s": 3600.0,
    "id": "hourly"
  },
  "ok": true
}
```

Errors: `400 INVALID_TIMER`; `404 TIMER_NOT_FOUND`; `413 TOO_MANY_TIMERS` beyond 32.

### `PUT /api/v1/fabric/apps/{id}/storage/{key}`

Keeps a value across restarts of either side. The whole body is the value. `GET .../storage/{key}` reads it, `DELETE` removes it, and `GET .../storage` lists keys. **Not encrypted, so don't put secrets here.**

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it. **Capability:** `storage`.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `value` | any | Yes |  |  |

```json
{
  "value": {
    "route": [
      1,
      2,
      3
    ]
  }
}
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {},
  "ok": true
}
```

Errors: `404 KEY_NOT_FOUND`; `413 STORAGE_FULL` beyond 256 keys or 256 KiB.

### `POST /api/v1/fabric/apps/{id}/messages`

Sends another application a message, arriving as a `message` event.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it. **Capability:** `apps.messages`.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `to` | string | Yes | An application with `apps.messages` |  |
| `type` | string | Yes |  |  |
| `data` | any | No | Up to 16 KiB in all |  |

```json
{
  "to": "org.example.other",
  "type": "route.ready",
  "data": {
    "id": 4
  }
}
```

Errors: `400 INVALID_MESSAGE`; `403 RECIPIENT_NOT_LISTENING`; `404 APP_NOT_FOUND`; `413 MESSAGE_TOO_LARGE`; `429 RATE_LIMITED`.

### `PUT /api/v1/fabric/apps/{id}/stops`

Sets bus stops of its own, and answers with the demand each would see. `GET .../stops` asks again.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it. **Capability:** `sim.read`.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `nodes` | array | Yes | Up to 4096 junctions |  |

```json
{
  "nodes": [
    5,
    6
  ]
}
```

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "items": [
      {
        "baseline": 1.5425745058719866,
        "generators": 24,
        "multiplier": 1.5425745058719866,
        "node": 5,
        "x_m": 790.9237533390755,
        "y_m": -149.14392985573926
      },
      {
        "baseline": 1.5425745058719866,
        "generators": 24,
        "multiplier": 1.5504616055206302,
        "node": 6,
        "x_m": 642.6204257756148,
        "y_m": 52.26734614402744
      }
    ],
    "virtual_s": 28883
  },
  "ok": true
}
```

Errors: `400 INVALID_STOPS`.

### `GET /api/v1/fabric/apps/{id}/settings`

Its settings, with their schema and values. `PUT` changes fields, all or none, and needs `settings` when called with a token. `DELETE`, by the observer or operator, goes back to defaults. An application only ever reaches **its own** settings, and never a person's.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it, or the observer or operator.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "values": {},
    "version": 0
  },
  "ok": true
}
```

Errors: `400 INVALID_SETTINGS`.

### `POST /api/v1/fabric/apps/{id}/control`

Acts on the simulation, with the capability that action needs, and a record of it either way. Starting runs and terminating the server aren't offered.

**Who:** The application: `Authorization: Bearer <token>`, and signed if it requires it.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `action` | string | Yes | Below |  |
| `params` | object | No | As the matching engine route |  |

```json
{
  "action": "pause"
}
```

| Capability | Actions |
|---|---|
| `control.playback` | `play`, `pause`, `seek`, `step`, `tick_rate`, `reset` |
| `control.events` | `weather`, `traffic`, `surge`, `edge_override` (with `edge`), `signal_toggle` (with `node`), `day`, `module` (with `module`, `enabled`), `undo`, `redo` |
| `control.world` | `regenerate` |

Response `200`, from a real run:

```json
{
  "changed": false,
  "lifecycle": "PAUSED",
  "ok": true,
  "playback_revision": 10,
  "run_id": "run_f104c50a105b"
}
```

Errors: `400 UNKNOWN_ACTION`; `403 WORLD_REGENERATION_DISABLED`.

## Applications: what a person decides

These belong to the person watching, and answer `403 HOST_REQUIRED` to anyone else.

### `PUT /api/v1/fabric/apps/{id}/grants`

The complete set of what's granted. Dropping `ui.layers` lets go of what it held at once.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `capabilities` | array | Yes | Only what it asked for |  |

```json
{
  "capabilities": [
    "ui.panels",
    "ui.status",
    "ui.overlays"
  ]
}
```

Errors: `400 CAPABILITY_NOT_REQUESTED`.

### `POST /api/v1/fabric/apps/{id}/suspend`

Hides it, and lets go of what it held. `POST .../resume` restores it, and only a person can.

**Who:** The observer or the operator.

Errors: `409 APP_NOT_ACTIVE`.

### `POST /api/v1/fabric/apps/{id}/actions`

What a person did with something on screen, which reaches the application as `ui.action`.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `element` | string | Yes |  |  |
| `action` | string | No | Default `activate` |  |
| `value` | any | No |  |  |

### `POST /api/v1/fabric/apps/{id}/failure`

Says its interface failed, for example a frame that never answered.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `detail` | string | No |  |  |

### `POST /api/v1/fabric/apps/{id}/view/outcome`

What became of a request to move the map.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `request` | integer | Yes |  |  |
| `outcome` | string | Yes | `applied` or `declined` |  |
| `reason` | string | No | Up to 80 bytes |  |

Errors: `400 INVALID_VIEW`.

### `GET /api/v1/fabric/state`

Everything applications have declared, in one poll, for the observer: only what changed since `since`, with what has been asked of the view.

**Who:** Anyone who can reach the port.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `since` | integer | No | Default 0 | Last `revision` |
| `notifications_since` | integer | No | Default 0 |  |
| `view_since` | integer | No | Default 0 | Last `view_sequence`. Requests older than 5 s aren't sent |

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "apps": [
      {
        "author": "",
        "blocked_ui": [],
        "capabilities": {
          "granted": [
            "apps.messages",
            "control.playback",
            "… and 9 more"
          ],
          "pending": [],
          "requested": [
            "ui.panels",
            "ui.status",
            "… and 9 more"
          ]
        },
        "description": "Plans a bus route.",
        "detail": "",
        "id": "org.example.planner",
        "name": "Planner",
        "order": 0,
        "security": {
          "frame_origins": [],
          "signatures_required": false
        },
        "settings": null,
        "state": "active",
        "ui": [
          {
            "id": "summary",
            "label": "Fleet",
            "slot": "status",
            "value": "13 buses"
          }
        ],
        "user_suspended": false,
        "version": "1.0.0",
        "web": null
      }
    ],
    "full": true,
    "launch_plan": null,
  … (shortened)
```

### `GET /api/v1/fabric/capabilities`

What this server offers: capabilities, slots, widgets, features, tones, topics, layers and limits. Find out rather than assume.

**Who:** Anyone who can reach the port.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "capabilities": {
      "automatic": [
        "apps.messages",
        "settings",
        "… and 11 more"
      ],
      "needs_a_person": [
        "control.events",
        "control.playback",
        "… and 5 more"
      ]
    },
    "layers": [
      "buildings",
      "events",
      "… and 10 more"
    ],
    "layout": {
      "area": [
        "column",
        "row",
        "… and 2 more"
      ],
      "columns": {
        "default": 6,
        "max": 12,
        "min": 1
      }
    },
    "limits": {
      "apps": 64,
      "elements": 64,
      "events_kept": 1000,
      "message_bytes": 16384,
      "storage_bytes": 262144,
      "storage_keys": 256,
      "timers": 32,
      "topics": 32,
      "ui_bytes": 4194304
    },
    "manifest_version": 1,
    "motions": [
      "none",
  … (shortened)
```

### `GET /api/v1/fabric/audit`

The record of what applications did: the latest 2000, held in memory.

**Who:** Anyone who can reach the port.

Query parameters:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `limit` | integer | No | Default 200, at most 2000 |  |

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "items": [
      {
        "action": "presentation",
        "app_id": "org.example.planner",
        "at_ms": 1793606530848,
        "hash": "21268eb184ae63ce2e617835aa3c066fb4e1bd6974bffb9a2a6335205ea2eec8",
        "outcome": "held",
        "params": {
          "layers": {
            "traffic": true,
            "weather": false
          },
          "places": {
            "school": false
          }
        },
        "previous": "944459d5e0a6f301b45e63f72cd280303982d3f71eda89c5b789dc4518b285ab",
        "run_id": "run_f104c50a105b",
        "sequence": 2,
        "virtual_s": 28883.0
      },
      {
        "action": "pause",
        "app_id": "org.example.planner",
        "at_ms": 1793606530850,
        "hash": "d79998ebd35cc9ee61bb945de43fe3d9c7ea8b5184a18cdf22dae10026820bf3",
        "outcome": "ok",
        "params": {},
        "previous": "21268eb184ae63ce2e617835aa3c066fb4e1bd6974bffb9a2a6335205ea2eec8",
        "run_id": "run_f104c50a105b",
        "sequence": 3,
        "virtual_s": 28883.0
      }
    ]
  },
  "ok": true
}
```

### `GET /api/v1/fabric/audit/verify`

Walks the hash chain. See [the audit log](security.md#the-audit-log).

**Who:** The observer or the operator.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "checked": 3,
    "head": "d79998ebd35cc9ee61bb945de43fe3d9c7ea8b5184a18cdf22dae10026820bf3",
    "intact": true
  },
  "ok": true
}
```

### `GET /api/v1/fabric/security`

What is protecting what, right now.

**Who:** The observer or the operator.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "applications": {
      "registered": 1,
      "requiring_signatures": 0
    },
    "audit": {
      "entries": 3,
      "head": "d79998ebd35cc9ee61bb945de43fe3d9c7ea8b5184a18cdf22dae10026820bf3",
      "verification": {
        "checked": 3,
        "head": "d79998ebd35cc9ee61bb945de43fe3d9c7ea8b5184a18cdf22dae10026820bf3",
        "intact": true
      }
    },
    "store": {
      "rejected": false,
      "sealed": true,
      "tokens": "hashed"
    },
    "transport": {
      "tls": false,
      "tls_available": false
    }
  },
  "ok": true
}
```

### `POST /api/v1/fabric/apps/{id}/reload`

Starts an application again. Its link ends at once: the token and signing key stop working, and what it declared, queued, timed and held is cleared. If the launcher started it, the launcher starts it again, and it comes back with the launcher's one-time key, keeping its grants, settings and storage. Otherwise nobody can prove to be it, so it registers again as new, and a person grants again whatever needs a person.

**Who:** The observer or the operator.

### `PUT /api/v1/fabric/launch/{id}/key`

The launcher's one-time key for a process it's about to start, as a SHA-256 hash. The process presents the key itself, in `X-DSTNS-Launch-Key`, when it registers, which proves it's that application. Each key works once.

**Who:** The observer or the operator.

Body:

| Field | Type | Required | Limits and default | Meaning |
|---|---|---|---|---|
| `key_sha256` | string | Yes | 64 hex characters |  |

Errors: `400 INVALID_LAUNCH`.

### `GET /api/v1/fabric/launch`

Launch proposals waiting for a person. `PUT .../launch/{id}` and `DELETE .../launch/{id}` add and withdraw one. `PUT` and `DELETE .../launch/plan` say what the launcher is starting, for the observer to show.

**Who:** The observer or the operator.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "items": [
      {
        "at_ms": 1793606530845,
        "id": "org.example.planner",
        "proposed_by": "application",
        "spec": {
          "commands": [
            "python3 planner.py"
          ],
          "ready": "fabric"
        }
      }
    ]
  },
  "ok": true
}
```

Errors: `404 PROPOSAL_NOT_FOUND`.

## Daemons

Small watchers run inside the server, each on a thread of its own, and say what they notice on two queues: **daemonEmergencyQueue**, for alerts and emergencies, and **daemonNotificationQueue**, for everything else. An application should read the emergency queue while the daemons are on, and act on what it hears at once. See [the daemons](../guide/daemons.md) for what each one watches.

### `GET /api/v1/daemon`

Whether the daemons are on, which are running, and the two queues: how many messages each holds, the latest sequence, and who has read it in the last minute. Anyone may ask, without a token, to find out whether to subscribe.

**Who:** Anyone.

Response `200`, from a real run:

```json
{
  "api_version": "1.4",
  "data": {
    "daemons": [
      {"description": "Resource Control Subsystem: each module's memory and processor against its α, β and γ", "enabled": true, "name": "rcs", "running": true},
      {"description": "The machine's memory: how much is left, before anything has to be stopped", "enabled": true, "name": "memory", "running": true}
    ],
    "enabled": true,
    "queues": {
      "daemonEmergencyQueue": {"latest_sequence": 0, "length": 0, "subscribers": ["org.example.planner"]},
      "daemonNotificationQueue": {"latest_sequence": 2, "length": 2, "subscribers": ["observer"]}
    },
    "subscribe": {"daemonEmergencyQueue": "/api/v1/daemon/emergency-queue", "daemonNotificationQueue": "/api/v1/daemon/notification-queue"},
    "sustain_s": 5
  }
}
```

### `GET /api/v1/daemon/messages`

Every message a daemon can send, as templates: its level, title and text, with `{name}`s filled in from the message's data. The same as `Daemon/messages.json`.

**Who:** Anyone.

### `GET /api/v1/daemon/emergency-queue`, `GET /api/v1/daemon/notification-queue`

The messages after `since`, oldest first. Reading is subscribing: an application that has read a queue in the last minute is listed as one of its subscribers.

**Who:** The observer or the operator, or an application by its token, naming itself with `?app=ID` or `X-DSTNS-App`.

| Query | Meaning |
|---|---|
| `since` | The last sequence seen; 0, or nothing, for everything the queue still holds |
| `wait` | Up to 25 seconds to wait for something new before answering |
| `limit` | At most this many, up to 500 (100 by default) |

Response `200`:

```json
{
  "api_version": "1.4",
  "data": {
    "items": [
      {
        "acknowledged_by": [],
        "daemon": "rcs",
        "data": {"alpha": 4, "beta": 2048, "gamma": 4096, "metric": "memory", "module": "engine", "sustain_s": 5, "unit": "MiB", "value": 4210.3},
        "id": "rcs.over_gamma",
        "level": "alert",
        "queue": "daemonEmergencyQueue",
        "sequence": 1,
        "text": "engine has used 4210 MiB of memory for 5.0 s, over its γ, the most it should ever use, of 4096 MiB.",
        "time_ms": 1793700123456,
        "title": "engine is over its memory limit"
      }
    ],
    "latest_sequence": 1,
    "missed": 0,
    "queue": "daemonEmergencyQueue"
  }
}
```

`missed` counts messages that left the queue before this reader asked for them: the emergency queue keeps 200, the notification queue 500.

Errors: `401 APP_REQUIRED`, `401 APP_TOKEN_INVALID`, `404 APP_NOT_FOUND`, `409 DAEMONS_OFF`.

### `POST /api/v1/daemon/emergency-queue/{sequence}/ack`

An emergency heard and acted on. Who has acknowledged it is listed with it.

**Who:** The observer or the operator, or an application by its token.

Errors: `404 NOT_FOUND`, `409 DAEMONS_OFF`.

### `PUT /api/v1/daemon/rcs/processes`

The processes a module runs in, for the Resource Control Subsystem to watch. The launcher reports itself (`launcher`) and the applications it started (`applications`); the engine and its map downloads it finds for itself.

**Who:** The operator.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `module` | string | Yes | `launcher`, `applications`, or a name of your own with its limits in the settings |
| `pids` | array of integers | Yes | Its processes |

Errors: `400 BAD_MODULE`, `403 OPERATOR_REQUIRED`.

### `GET /api/v1/daemon/{name}`

One daemon (`rcs`, `memory`, `disk`, `stall`, `cache`): whether it is on, how often it wakes, what it last read, and its settings.

**Who:** The observer or the operator, or an application by its token.

Errors: `404 NOT_FOUND`, `409 DAEMONS_OFF`.

### `PUT /api/v1/daemon/{name}`

Turn a daemon on or off, or change its settings while the server runs: `{"enabled": false}`, `{"settings": {"modules": {"engine": {"memory_mib": [4, 1024, 2048]}}}}` for the Resource Control Subsystem, `{"settings": {"max_mib": 1024}}` for the cache, and `{"sustain_s": 3}` for how long any condition must hold before it says anything. A daemon turned on or off says so on the notification queue.

**Who:** The operator.

Errors: `400 BAD_SETTINGS`, `403 OPERATOR_REQUIRED`, `404 NOT_FOUND`.

## Older routes

These work as they always have, and also carry a `legacy` field in the JSON, with `Deprecation: true`, `Warning` and `X-DSTNS-Successor` headers. They're open to any program that can reach the port, which `/api/v1/fabric/engine/` isn't: see [what is not protected](security.md#what-is-not-protected).

| Older route | Use instead |
|---|---|
| `/api/v1/playback/{status, start, prepare, play, pause, stop, reset, seek, step}` | `/api/v1/fabric/engine/...` |
| `POST /stop` | `POST /api/v1/fabric/engine/stop` |
| `PUT /api/v1/control/tick-rate` | `PUT /api/v1/fabric/engine/tick-rate` |
| `POST /api/v1/control/day` | `POST /api/v1/fabric/engine/day` |
| `PUT /api/v1/control/modules/{module}`, `POST .../{enable or disable}` | `/api/v1/fabric/engine/modules/...` |
| `POST /api/v1/control/events/{weather, traffic, surge}` | `/api/v1/fabric/engine/events/...` |
| `PUT /api/v1/control/edges/{id}`, `POST .../override` | `/api/v1/fabric/engine/edges/...` |
| `POST /api/v1/control/signals/{id}`, `.../toggle` | `/api/v1/fabric/engine/signals/...` |
| `POST /api/v1/control/{undo, redo}`, `GET .../history` | `/api/v1/fabric/engine/...` |
| `POST /api/v1/control/transit/route` | Retired: `410 TRANSIT_API_RETIRED` |
