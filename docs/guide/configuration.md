# Configuration

DSTNS reads configuration from four places: `config/defaults.json` for run
defaults, `config/ui-config.json` for the observer's starting state, command
line flags on the CLI and the server, and environment variables. This page
lists every setting, its range, and which component actually reads it.


## Precedence

For a run started from the CLI, later sources win:

1. Built-in defaults in `ScenarioConfig` (`Core/core-legacy/include/dstns/model.hpp`)
2. `config/defaults.json`
3. A saved seed (`--saved-seed ID`), which replaces 2 entirely
4. CLI flags (`--seed`, `--day-type`, `--duration`, `--speed`, `--max-nodes`, `--osm-file`, `--engine`)

The CLI turns the result into the body of `POST /api/v1/playback/start`, and
the server validates it again. Each bound is enforced in both places, so a
configuration the CLI accepts is one the engine accepts.

## Files in `config/`

Every file has the same shape. A file starts with four keys, then its values:

| Key | What it is |
|---|---|
| `$schema` | Its JSON Schema in `config/schema/`. An editor that reads JSON Schema (VS Code does) checks the file as it is typed, and shows each value's meaning, accepted values and default on hover |
| `schema_version` | The layout of the file |
| `_about` | What the file is, who reads it, and when a change applies |
| `_help` | Each editable value, by its dotted path: what it means, what it accepts, its default |

| File | Read by | Schema |
|---|---|---|
| `defaults.json` | launcher, and through it the engine | `schema/defaults.schema.json` |
| `ui-config.json` | the observer (served by the server) and the launcher | `schema/ui-config.schema.json` |
| `engines.json` | launcher and server | `schema/engines.schema.json` |
| `daemon-alerts.json` | built into the server | `schema/daemon-alerts.schema.json` |
| `building_profiles.json`, `road_types.json` | nothing: reference copies of values the engine holds in code | `schema/building_profiles.schema.json`, `schema/road_types.schema.json` |

No program reads `_about` or `_help`. For the launcher's three files, the schemas and `_help` are generated from the
launcher's settings table: `./launcher config docs` rewrites them and leaves every value as it is. A launcher test
fails when they are stale, or when a file in `config/` lacks the header or its schema.

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
| `playback.tick_rate` | `1.0` | (0, 10] | CLI, engine | Initial speed multiplier |
| `playback.checkpoint_virtual_seconds` | `900` | [60, 3600] s | CLI, engine | How often a run keeps a checkpoint. Closer makes seeking back faster and takes more memory; it never changes results |

### Engine

Kept in `config/engines.json` (see [Engine governance](../design/engine-governance.md)); the rest of the table is in
`config/defaults.json`.

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `engines.selected` | `core-ng` | an enabled engine | CLI | Which engine builds and runs each world. Both give the same world for the same seed under `urban-crfg-v3` |
| `engines.auto_switch` | `offer` | `offer`, `off` | server | Whether rejecting an unstable engine's run offers to start the seed on a stable engine |
| `engines.engines.core-ng.enabled` | `true` | on only | CLI | The default engine cannot be turned off |
| `engines.engines.core-ng.acknowledgment.enforce` | `true` | on or off | server | Hold each core-ng run until a person accepts the risk. Off turns the observer's acknowledgment off too |
| `engines.engines.core-ng.acknowledgment.ui` | `true` | on or off | server, observer | Ask in the observer; off while enforced, the launcher asks (`--accept-risk`) |
| `engines.engines.core-legacy.enabled` | `true` | on or off | CLI, server | Off: core-legacy stays installed, but nothing can start on it |
| `map.selection_mode` | `global` | `global`, `countries`, `cities`, `fixed_city` | CLI | Which cities a seed may choose. With `global` and something in Places, Places decides: two-letter codes are countries, other names cities |
| `map.places` | `all` | comma-separated IDs, `-` before one to leave it out | CLI | Countries (ISO 3166-1 alpha-2, such as `IN, AE`) or city IDs (such as `mumbai, new-york`). `-IN` is everywhere but India; `IN, -mumbai` is India without Mumbai. Countries are written in capitals and cities in lower case with hyphens before the request is sent |

Anything in Places needs core-ng: a start with core-legacy and Places set is refused before the server is called.
Setting `engines.selected` to `core-legacy` sets `map.selection_mode` back to `global` and Places back to `all`.
Dynamic Fastboot's prepared world is used only when nothing limits where worlds are. A launch code carries these
settings like any other.

### Map

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `map.osm_file` | absent (`auto`) | path or `auto` | CLI | `auto` lets the seed choose a city and district; a path pins a map |
| `map.max_nodes` | `50000` | [2, 50000] | CLI, engine | Upper bound on graph size |
| `map.cache_dir` | `data/maps` | path | CLI, engine | Where downloaded city extracts are cached |
| `map.city_extent_m` | `5000` | [500, 20000] | CLI, engine | Side of the square extract downloaded per city. Sent only when it is not 5000; Dynamic Fastboot's prepared world is used only when it was prepared with the same extent |
| `map.district_nodes` | `3000` | [200, 50000] | CLI, engine | Target size of the district grown from the seed's anchor. Sent only when it is not 3000 |
| `map.map_selection_version` | `urban-crfg-v3` | — | informational | The launcher sends the version that `map.selection_mode` names |
| `map.cache_policy` | `prune` | `keep`, `prune`, `clear` | CLI, server (`--map-cache`) | What the server does with the map cache as it starts |
| `map.cache_keep` | `1` | [0, 1000] | CLI, server (`--map-cache-keep`) | Cities kept when pruning |
| `map.download_stall_s` | `200` | [10, 3600] | CLI, server (`DSTNS_MAP_STALL_S`) | How long a download may receive nothing before the next map server is tried |
| `map.source`, `map.on_demand`, `map.min_nodes`, `map.max_anchor_attempts`, `map.min_compactness` | | | informational | |

### Modules

`modules.traffic`, `signals`, `buildings`, `dws`, `flooding`, `news`: booleans,
all `true` by default. Each switches one subsystem. A client of the API can also
switch them during a run with `PUT /api/v1/control/modules/{module}`; the observer
does not, because its layer toggles change only what is drawn.

| Module | Off means |
|---|---|
| `traffic` | No base or hotspot demand: roads stay empty apart from surges |
| `signals` | No controllers compiled; manual overrides have no effect |
| `buildings` | Places exert no demand and report a 1.0 multiplier |
| `dws` | No rain, scheduled or manual |
| `flooding` | Flood levels held at 0 |
| `news` | No new news items |

### SUMO

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `sumo.enabled` | `false` | on or off | CLI, server (`DSTNS_SUMO`) | Off, the SUMO routes return 403 `SUMO_DISABLED`, the server does not look for SUMO, and `./launcher sumo` says it is off. `./launcher test sumo` still runs |
| `sumo.home` | `auto` | path or `auto` | CLI, server (`SUMO_HOME`) | Where SUMO is installed. `auto` searches `SUMO_HOME`, `~/sumo`, Homebrew and the system's folders |

A server started without the launcher keeps SUMO on, as before.

### Weather

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `dws.frequency` | `3` | 0 or more, at least 5 playback seconds apart over the day | CLI, engine | Storms scheduled per day |
| `dws.storm_gap_s` | `5` | [0, 600] s | CLI, engine | The least gap between two scheduled storms' starts, in playback seconds |
| `dws.storm_min_minutes` | `45` | [5, 1440] min | CLI, engine | The shortest scheduled storm, in simulated minutes |
| `dws.storm_max_minutes` | `120` | [5, 1440] min, at least the shortest | CLI, engine | The longest scheduled storm; each is drawn between the two |
| `dws.min_start_gap_playback_seconds`, `min_duration_virtual_min`, `max_duration_virtual_min` | | | ignored | Replaced by the three above in engine 3.11.0. They were never read, and `20` was not the engine's shortest storm (45) |

### Bus stops

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `bus_stops.min_spacing_m` | `300` | [50, 5000] m | CLI, engine | The least distance along the roads between two stops |
| `bus_stops.target_spacing_m` | `500` | [50, 5000] m | CLI, engine | The spacing stops are placed at where the roads allow |
| `bus_stops.max_coverage_m` | `800` | [50, 10000] m | CLI, engine | No junction is farther than this from a stop |
| `bus_stops.building_annulus_m` | `[80, 250]` | | informational | The ring round a stop where buildings may be placed; fixed |

At their defaults these give every seed the world it has always had. Changed, they make another world from the
same seed: a saved seed and a launch code carry them, so that world can be made again.

### Server

| Key | Default | Range | Read by | Meaning |
|---|---|---|---|---|
| `api.host` | `127.0.0.1` | address | CLI | Interface the server binds; the default keeps it local, `0.0.0.0` exposes it |
| `api.port` | `8090` | [1, 65535] | CLI | Preferred port; the CLI picks the next free one if it is taken by something else |
| `api.allowed_hosts` | `none` | comma-separated host names | CLI, server (`DSTNS_ALLOWED_HOSTS`) | Host names besides localhost accepted by a server bound to loopback |
| `api.allowed_origins` | `none` | comma-separated origins | CLI, server (`DSTNS_ALLOWED_ORIGINS`) | Origins besides the server's own that may change things |
| `ui.port` | `5173` | | informational | The Vite dev server port is set in `WebKit/vite.config.ts` |

Still informational, on purpose: `bus_stops.building_annulus_m` (fixed); `traffic.*` (this engine's traffic model is
not a BPR model, so these are not its parameters); `logging.*` (the server writes everything to `<logs>/system.log`
and `<logs>/runtime.db` and has no level to set); `ui.osm_background`. A launcher test checks that every other key in
`config/defaults.json` is a setting (`INFORMATIONAL` in `LaunchKit/src/config.rs`).

## Start request fields

What `POST /api/v1/playback/start` and `/prepare` accept (the CLI builds this):

| Field | Type | Rule |
|---|---|---|
| `seed` | number or string | Decimal, `0x` hex (up to 128 bits), `auto`, `random`, `""` or `0` (fresh seed) |
| `day` | 0, 1 or `"auto"` | |
| `playback_duration_seconds` (alias `simulation_time`) | integer | [60, 3600] |
| `tick_rate` | number | (0, 10] |
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
                 [--max-nodes 2-50000] [--osm-file PATH] [--engine core-legacy|core-ng] [--no-open]
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
| `DSTNS_FETCHER` | server | The program that downloads maps (default: the server itself, as `dstns_server --fetch-osm`) |
| `DSTNS_OVERPASS_ENDPOINTS` | map downloader | Comma-separated Overpass API endpoints to try |
| `DSTNS_MAP_STALL_S` | server | Seconds a map download may go without new data before it fails (default `200`) |
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
