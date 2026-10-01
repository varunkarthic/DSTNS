# Playback API

Starting a run and moving through its virtual day. All routes are under
`/api/v1/playback`. State-changing routes refuse cross-site browser requests
(see [Security](../deployment/security.md#origin-check-cross-site-request-forgery)); errors follow
[API errors](errors.md).

| Method | Route | Purpose |
|---|---|---|
| POST | `/start` | Compile a world and run it (operator credential required) |
| POST | `/prepare` | Compile a world and hold it `READY` (operator credential required) |
| GET | `/status` | Lifecycle, clock and run summary |
| POST | `/play` | Resume a paused run |
| POST | `/pause` | Hold the clock |
| POST | `/seek` | Jump to a virtual time |
| POST | `/step` | Advance a fixed amount and hold |
| POST | `/stop` | End the run, keeping the world |
| POST | `/reset` | Discard the world and return to `IDLE` |

## POST /start

Requires `X-DSTNS-Operator` (403 `CLI_START_REQUIRED` otherwise). Returns 202
immediately; compilation, including any map download, continues in the
background. Poll `/status` until `lifecycle` leaves `PREPARING`, and
`/api/v1/system/map-status` for download progress.

```json
{
  "seed": "382923",
  "day": 0,
  "playback_duration_seconds": 3600,
  "tick_rate": 1,
  "start_virtual_time": "06:00:00",
  "map": { "osm_file": "auto", "max_nodes": 50000 },
  "modules": { "traffic": true, "signals": true, "buildings": true, "dws": true, "flooding": true, "news": true },
  "dws": { "frequency": 3 },
  "map_selection_version": "urban-crfg-v3"
}
```

Every field is optional; see [Configuration](../guide/configuration.md#start-request-fields)
for each field's range.

```json
{ "ok": true, "api_version": "1.0", "run_id": "",
  "data": { "accepted": true, "lifecycle": "PREPARING", "seed": "382923", "seed_hex": "0x…" } }
```

409 if a run is already `RUNNING`, `PAUSED` or `PREPARING`. A failed
compilation returns the run to `IDLE` and leaves the reason in
`status.data.preparation_error`.

## POST /prepare

Same body and credential as `/start`, but synchronous: it returns 200 once the
world is compiled and `READY`, without starting the clock. It stops a running
world first.

## GET /status

The standard envelope with:

| Field | Meaning |
|---|---|
| `lifecycle` | `IDLE`, `PREPARING`, `READY`, `RUNNING`, `PAUSED`, `SEEKING`, `STOPPED`, `COMPLETED`, `TERMINATING` |
| `preparation_error` | Why the last preparation failed, or empty |
| `playback_revision` | Increments on every lifecycle change; used by playback guards |
| `run_id` | `run_` plus 12 hex digits of the scenario hash |
| `day` | 0 weekday, 1 weekend, -1 without a world |
| `paused`, `simulated_seconds`, `virtual_seconds_remaining`, `checkpoint_count` | |
| `modules` | Each module's on/off state |

`clock` in the envelope carries `virtual_day_seconds`,
`simulated_current_time` (`HH:MM:SS`), `simulation_percentage` (a fraction in
[0, 1]), `base_rate`, `tick_rate` and `target_virtual_rate`.

## POST /play, POST /pause

An empty body, or a guard:

```json
{ "expected_run_id": "run_3fa2…", "expected_playback_revision": 41, "require_asb_normal": true }
```

A guard that no longer holds gives 409; this is how an automated pause (the
tutorial's, say) avoids overriding a decision the operator made since. Pausing
a paused run and playing a running one succeed with `"changed": false`.

## POST /seek

```json
{ "target_time": "17:30:00", "play": false }
```

`target_time` is seconds in [0, 86400] or `HH:MM:SS`. Earlier times restore
the nearest checkpoint (every 15 virtual minutes) and replay to the target;
later times simulate forward. Seeking and playing to the same time give
identical state. The run ends `RUNNING` if it was running or `play` is true,
otherwise `PAUSED`, and `COMPLETED` at 86400. 409 while `PREPARING` or
`TERMINATING`.

```json
{ "target_time": "17:30:00", "simulated_seconds": 63000, "lifecycle": "PAUSED", "state_revision": 63002 }
```

## POST /step

```json
{ "seconds": 60 }
```

Advances exactly `seconds` (1 to 3600, default 60) with the same one-second
physics as playback, and always leaves the run `PAUSED`, or `COMPLETED` if it
reaches 24:00:00. 409 at 24:00:00.

```json
{ "from_seconds": 29100, "simulated_seconds": 29160, "stepped_seconds": 60,
  "target_time": "08:06:00", "lifecycle": "PAUSED", "playback_revision": 57, "state_revision": 29162 }
```

## POST /stop, POST /reset

`stop` moves the run to `STOPPED` and keeps the world readable. `reset`
discards the world, cancels any compilation in flight, clears all run state and
returns to `IDLE`. Neither takes a body. `POST /stop` is also available at the
root path.
