# Schemas and types

The types that recur across the API. Full machine-readable schemas are in the
[OpenAPI description](openapi.md).

| Type | JSON | Range and meaning |
|---|---|---|
| Node ID, edge ID | integer | 0 to 2³²−1; canonical, 0-indexed within a run |
| Seed | string (decimal) | Up to 128 bits; `seed` in decimal, `global_seed` / `seed_hex` as 32 hex digits with `0x` |
| Run ID | string | `run_` + 12 hex digits of the scenario hash |
| Virtual time | integer seconds, or `"HH:MM:SS"` | 0 to 86,400 |
| `simulation_percentage` | number | A fraction, 0 to 1 |
| Speed | number, m/s | × 3.6 for km/h |
| Capacity, demand | number, vehicles/hour | |
| Length, radius, `x_m`, `y_m` | number, metres | True metres; `x_m`/`y_m` from the projection origin |
| `lat`, `lon` | number, degrees | WGS 84 |
| Congestion (edge) | number | 0 to 1 |
| Congestion (network) | number | 0 to 100 |
| Rainfall, flood, intensity | number | 0 to 1 |
| Multipliers | number | 0 to 2 for operator overrides; 0 to 1 for weather and incidents |
| Tick rate | number | Greater than 0, at most 5 |
| Revisions | integer | Monotonic within a run |
| Hashes | string | `sha256:` + 64 hex digits |

## The envelope

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | `true` for success |
| `api_version` | string | `"1.0"` |
| `run_id` | string | Empty without a world |
| `seed`, `global_seed` | string | Decimal and hexadecimal forms |
| `state_revision`, `config_revision` | integer | See [Lifecycle: revisions](lifecycle.md#revisions) |
| `clock` | object | `playback_state`, `virtual_day_seconds`, `simulated_current_time`, `simulation_percentage`, `playback_duration_seconds`, `base_rate`, `tick_rate`, `target_virtual_rate` |
| `data` | object | The route's payload |

## Errors

```json
{ "ok": false, "api_version": "1.0", "error": { "code": "INVALID_REQUEST", "message": "…" } }
```

See [Errors](errors.md).

## Enumerations

| Name | Values |
|---|---|
| Lifecycle | `IDLE`, `PREPARING`, `READY`, `RUNNING`, `PAUSED`, `SEEKING`, `STOPPED`, `COMPLETED`, `TERMINATING`, `ERROR` (reserved) |
| Road class | `motorway`, `primary`, `secondary`, `tertiary`, `residential`, `service` |
| Building / demand type | `school`, `office`, `mall`, `store` |
| Place kind | `school`, `university`, `office`, `retail`, `mall`, `hospital`, `pharmacy`, `food`, `transport`, `bus_stop`, `parking`, `park`, `industrial`, `residential`, `worship`, `culture`, `hotel`, `other` |
| Incident type | `road_closure`, `accident`, `congestion`, `vehicle_breakdown`, `hazard_spill` |
| Module | `traffic`, `signals`, `buildings`, `dws`, `flooding`, `news` |
| News severity | `info`, `warning`, `alert` |
| ASB state | `NORMAL`, `RESTRICTED`, `ASYNC` |
