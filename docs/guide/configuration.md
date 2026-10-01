# Configuration

DSTNS reads configuration from four places: `config/defaults.json` for run
defaults, `config/ui-config.json` for the observer's starting state, command
line flags on the CLI and the server, and environment variables. This page
lists every setting, its range, and which component actually reads it.


## Precedence

For a run started from the CLI, later sources win:

1. Built-in defaults in `ScenarioConfig` (`include/dstns/model.hpp`)
2. `config/defaults.json`
3. A saved seed (`--saved-seed ID`), which replaces 2 entirely
4. CLI flags (`--seed`, `--day-type`, `--duration`, `--speed`, `--max-nodes`, `--osm-file`)

The CLI turns the result into the body of `POST /api/v1/playback/start`, and
the server validates it again. Each bound is enforced in both places, so a
configuration the CLI accepts is one the engine accepts.

## `config/defaults.json`

The CLI validates this file on every start (`dstns config` edits it). Fields
marked *informational* document the built-in behaviour but are not currently
read; changing them has no effect.

### Run

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `seed` | `"auto"` | — | informational | Without `--seed` the CLI always draws a fresh 64-bit seed |
| `day` | `0` | `0` weekday, `1` weekend | CLI | Day type; `--day-type` overrides |
| `playback.duration_seconds` | `3600` | integer [60, 3600] | CLI, engine | Wall-clock seconds one virtual day takes at 1× |
| `playback.tick_rate` | `1.0` | (0, 5] | CLI, engine | Initial speed multiplier |
| `playback.checkpoint_virtual_seconds` | `900` | — | informational | Checkpoint spacing is fixed at 900 s |

### Map

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `map.osm_file` | absent (`auto`) | path or `auto` | CLI | `auto` lets the seed choose a city and district; a path pins a map |
| `map.max_nodes` | `50000` | [2, 50000] | CLI, engine | Upper bound on graph size |
| `map.cache_dir` | `data/maps` | path | CLI, engine | Where downloaded city extracts are cached |
| `map.city_extent_m` | `5000` | [500, 20000] | engine default | Side of the square extract downloaded per city |
| `map.district_nodes` | `3000` | [200, 50000] | engine default | Target size of the district grown from the seed's anchor |
| `map.map_selection_version` | `urban-crfg-v3` | exactly that | engine | Seed-to-place algorithm version; others are refused |
| `map.cache_policy` | `prune` | `keep`, `prune`, `clear` | informational | The server's `--map-cache` flag decides; its default is `prune` |
| `map.cache_keep` | `1` | ≥ 0 | informational | The server's `--map-cache-keep` flag decides; its default is 1 |
| `map.source`, `map.on_demand`, `map.min_nodes`, `map.max_anchor_attempts`, `map.min_compactness` | | | informational | |

### Modules

`modules.traffic`, `signals`, `buildings`, `dws`, `flooding`, `news`: booleans,
all `true` by default. Each switches one subsystem; the observer can also
toggle them at run time through `PUT /api/v1/control/modules/{module}`.

| Module | Off means |
|---|---|
| `traffic` | No base or hotspot demand: roads stay empty apart from surges |
| `signals` | No controllers compiled; manual overrides have no effect |
| `buildings` | Places exert no demand and report a 1.0 multiplier |
| `dws` | No rain, scheduled or manual |
| `flooding` | Flood levels held at 0 |
| `news` | No new news items |

### Weather

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `dws.frequency` | `3` | 0 or more, at least 5 playback seconds apart over the day | CLI, engine | Storms scheduled per day |
| `dws.min_start_gap_playback_seconds`, `min_duration_virtual_min`, `max_duration_virtual_min` | `5`, `20`, `120` | | informational | The compiler uses fixed values: 5 s spacing and 45 to 120 minute storms |

### Server

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `api.host` | `127.0.0.1` | address | CLI | Interface the server binds; the default keeps it local, `0.0.0.0` exposes it |
| `api.port` | `8090` | [1, 65535] | CLI | Preferred port; the CLI picks the next free one if it is taken by something else |
| `ui.port` | `5173` | | informational | The Vite dev server port is set in `ui-engine/vite.config.ts` |

`bus_stops.*`, `traffic.*`, `ui.osm_background` and `logging.*` are
informational: stop spacing is 300 m minimum, 500 m target and 800 m coverage,
logs go to `<logs>/system.log` and `<logs>/runtime.db`.

## Start request fields

What `POST /api/v1/playback/start` and `/prepare` accept (the CLI builds this):

| Field | Type | Rule |
|---|---|---|
| `seed` | number or string | Decimal, `0x` hex (up to 128 bits), `auto`, `random`, `""` or `0` (fresh seed) |
| `day` | 0, 1 or `"auto"` | |
| `playback_duration_seconds` (alias `simulation_time`) | integer | [60, 3600] |
| `tick_rate` | number | (0, 5] |
| `start_virtual_time` | seconds or `HH:MM:SS` | [0, 86400] |
| `map.osm_file` | string | Path or `auto` (the default when there is no `fixture`) |
| `map.max_nodes`, `map.city_extent_m`, `map.district_nodes`, `map.cache_dir` | | As in the table above |
| `modules.{traffic,signals,buildings,dws,flooding,news}` | boolean | `traffic_demand` and `traffic_signals` are accepted as aliases |
| `dws.frequency` | integer | As above |
| `fixture.grid_width`, `fixture.grid_height` | integer | Synthetic grid for tests; at least 3 × 3, and width × height ≤ `max_nodes` |
| `saved_seed_id` | string | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| `map_selection_version` | string | `urban-crfg-v3` |

## CLI flags

```
./launcher start [--seed N | --saved-seed ID] [--save-seed ID [--description TEXT]]
                 [--day-type weekday|weekend] [--duration 60-3600] [--speed 0.01-5]
                 [--max-nodes 2-50000] [--osm-file PATH] [--no-open]
./launcher seeds list
./launcher test [all|unit|api|replay|benchmark|sumo|ui]
./launcher ui [open|dev|build|install]
./launcher logs | config | sumo | reset | console | help
./launcher --mode=server        # the C++ server in the foreground
```

See [Operator CLI](operator-cli.md) for what each command does.

## Server flags

```
dstns_server [--host ADDR] [--port 1-65535] [--logs DIR] [--maps DIR]
             [--map-cache keep|prune|clear] [--map-cache-keep N] [--version] [--help]
```

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | Bind address; `0.0.0.0` exposes the API to the network |
| `--port` | `8090` | Listen port; values outside 1 to 65535 are refused |
| `--logs` | `logs` | System log, SQLite journal, `operator.token`, `global_view.json` |
| `--maps` | `data/maps` | Map cache swept at start-up |
| `--map-cache` | `prune` | `keep` nothing removed; `prune` keep the newest N extracts; `clear` remove all. Interrupted downloads (`.part`) and stale progress files (`.progress`) are always removed |
| `--map-cache-keep` | `1` | N for `prune` |

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `DSTNS_OPERATOR_TOKEN` | server, CLI | Use this operator credential instead of generating one |
| `DSTNS_ALLOWED_HOSTS` | server | Comma-separated extra `Host` names accepted when the server is bound to loopback (the guard against DNS rebinding). See [Security](../deployment/security.md#host-check-dns-rebinding) |
| `DSTNS_BIND` | Compose | Host address Compose publishes on (default `127.0.0.1`; `0.0.0.0` exposes the API to the network) |
| `DSTNS_ALLOWED_ORIGINS` | server | Comma-separated origins allowed to make state-changing requests besides the server's own. See [Security](../deployment/security.md#origin-check-cross-site-request-forgery) |
| `DSTNS_DISABLE_WORLD_REGENERATION` | server | `1` makes `/world/regenerate` return 403 |
| `DSTNS_PYTHON` | server | Python interpreter for the map downloader (default `python3`) |
| `DSTNS_OVERPASS_ENDPOINTS` | `fetch_osm.py` | Comma-separated Overpass API endpoints to try |
| `SUMO_HOME` | server, CLI | Where to find `bin/sumo` and `bin/netconvert` first |
| `DSTNS_API_PORT` | CLI, Vite, preflight | Port to use or proxy to, overriding `api.port` |
| `DSTNS_LOGS_DIR` | CLI | Logs directory passed to the server |
| `DSTNS_SEED_DB` | `seeds.py` | Saved-seed SQLite database (default `data/seed-store/seeds.sqlite3`) |
| `VITE_DSTNS_API_URL` | observer build | API base URL when the observer is served elsewhere; that origin then needs `DSTNS_ALLOWED_ORIGINS` |
| `CHROME_BIN` | browser tests | Chrome executable |

## Observer configuration

`config/ui-config.json` sets the observer's starting state (clock format,
layers, Auto Focus, notifications, Do Not Disturb, playback intervals). The
server serves it at `GET /api/v1/system/ui-config`; a malformed file is
reported and the observer falls back to built-in defaults. Every key, its
range and its default is documented in [Observer
configuration](observer-configuration.md).
