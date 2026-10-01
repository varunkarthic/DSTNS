# Limits and ranges

Every bound DSTNS enforces, in one place. Values outside a range are refused, never
silently clamped or wrapped: the CLI reports an error before anything starts, and the
API answers HTTP 400 with an error code (see [Errors](../api/errors.md)). Each limit
is enforced by the engine itself, so a client cannot bypass it.

## Runs

| Setting | Range | Default | Set with |
|---|---|---|---|
| Seed | Unsigned integer up to 128 bits, decimal or `0x` hexadecimal | A fresh 64-bit seed | `--seed`, `seed` |
| Day type | `weekday` (0) or `weekend` (1) | `weekday` | `--day-type`, `day` |
| Day duration at 1× | 60 to 3,600 wall-clock seconds, integer | 3,600 | `--duration`, `playback_duration_seconds` |
| Speed (tick rate) | Greater than 0, at most 5 | 1 | `--speed` (0.01 to 5), `tick_rate` |
| Speeds offered by the observer | 0.25, 0.5, 1, 2, 3, 5 | 1 | Command rail |
| Start time | 0 to 86,400 virtual seconds, or `HH:MM:SS` | 0 | `start_virtual_time` |
| Virtual day | 86,400 virtual seconds | | Fixed |
| Physics step | 1 virtual second | | Fixed |
| Checkpoint interval | 900 virtual seconds (15 minutes) | | Fixed |

## Maps

| Setting | Range | Default | Set with |
|---|---|---|---|
| Graph size cap | 2 to 50,000 nodes, integer | 50,000 | `--max-nodes`, `map.max_nodes` |
| District target size | 200 to 50,000 junctions | 3,000 | `map.district_nodes` |
| City extract side | 500 to 20,000 metres | 5,000 | `map.city_extent_m` |
| Smallest usable district | 400 junctions | | Fixed; smaller downloads fail with `MAP_FETCH_FAILED` |
| Synthetic grid (tests) | At least 3 × 3, and width × height at most the graph size cap | 12 × 10 | `fixture.grid_width`, `fixture.grid_height` |
| Cities in the catalogue | 181 | | Fixed under `urban-crfg-v3` |
| Signal snapping radius | 45 metres | | Fixed |
| Signal cycle | 50 to 120 seconds; each green at least 12 seconds | | Computed |

## Weather and incidents

| Setting | Range | Default | Set with |
|---|---|---|---|
| Scheduled storms per day | 0 or more, starting at least 5 playback seconds apart | 3 | `dws.frequency` |
| Scheduled storm duration | 45 to 120 virtual minutes | | Computed from the seed |
| Manual rain duration | 1 to 1,440 virtual minutes | | `duration_virtual_minutes` |
| Incidents per day | At least 4 | | Computed from the seed |

## Operator controls

| Control | Range |
|---|---|
| Edge speed and capacity multipliers | 0 to 2 each |
| Surge factor | Greater than 0, at most 10 |
| Surge radius | Greater than 0, at most 20,000 metres |
| Surge duration | 1 to 86,400 virtual seconds; ends no later than midnight |
| Traffic overlay pressure | 0 to 1 |
| Undo or redo count | 1 to 10,000 per request |
| Step | 1 to 3,600 virtual seconds; 60 by default |
| Seek target | 0 to 86,400 virtual seconds, or `HH:MM:SS` with hours 0 to 23 |
| SUMO time window | `begin_s` < `end_s` ≤ 86,400 |

## API paging and retention

| Item | Limit |
|---|---|
| Event queue page | 1 to 200 items; 50 by default; the observer requests 30 |
| Event queue offset | Up to 100,000 |
| Executed event history | The last 2,000 events, plus an all-time count |
| News page | 1 to 500 items; 100 by default |
| News stream | The latest 100 items |
| Recent news in a snapshot | The latest 25 items |
| Log rows per request | 1 to 1,000; 100 by default |
| System log tail | The last 250 lines |
| Path IDs (edges, nodes, signals) | Unsigned 32-bit; larger values are refused, not wrapped |

## Server and CLI

| Setting | Range | Default |
|---|---|---|
| Port | 1 to 65,535 | 8090 |
| Bind address | Any local address | `127.0.0.1` |
| Health wait when the CLI starts a server | 15 seconds | |
| Map cache entries kept by `prune` | 0 or more | 1; 3 in the container |
| Saved seed ID | 1 to 64 characters: letters, digits, `_`, `-`; first character a letter or digit | |
| Saved seed description | Up to 1,000 characters | |

## Observer

| Setting | Range | Default |
|---|---|---|
| Window size | At least 1024 × 640 CSS pixels | |
| Auto Focus dwell | 2 to 120 seconds | 9 |
| Auto Focus zoom | 0.2 to 8 | 1.6 |
| Notification lifetime | 1,000 to 60,000 milliseconds | 7,000 |
| Skip interval | 60, 300, 900 or 3,600 virtual seconds | 900 |
| Step interval | 1, 10, 60 or 300 virtual seconds | 60 |
| Report telemetry buffer | 2,400 samples, thinned when full | |

## Related

- [Configuration](../guide/configuration.md): where each setting lives
- [Errors](../api/errors.md): what a refused value returns
- [Known limitations](../limitations.md): constraints that are not simple ranges
