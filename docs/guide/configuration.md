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
4. CLI flags (`--seed`, `--day-type`, `--location`, `--month`, `--duration`, `--speed`, `--max-nodes`, `--osm-file`)

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
| `day` | `"auto"` | `"auto"`, `0` weekday, `1` weekend | CLI | Day type; `auto` is the seed's own; `--day-type` overrides |
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

### Compute

Where the physics step runs. Read by the launcher, which passes it to the
server it starts; see [GPU acceleration](gpu-acceleration.md).

| Key | Default | Range | Meaning |
|---|---|---|---|
| `compute.backend` | `auto` | `auto`, `cpu`, `vulkan` | `auto` uses a GPU only where it is measured faster; results are identical on every backend |
| `compute.allow_vulkan` | `true` | boolean | `false` switches GPU acceleration off |
| `compute.device` | `auto` | text | A device index, UUID or part of its name |
| `compute.require_vulkan` | `false` | boolean | With `vulkan`, refuse to start without a working GPU |
| `compute.allow_software_vulkan` | `false` | boolean | Allow llvmpipe and other CPU implementations of Vulkan |
| `compute.verification` | `false` | boolean | Recompute every GPU step on the CPU and compare |
| `compute.validation_layers` | `false` | boolean | Enable the Khronos validation layers |
| `compute.gpu_thresholds.min_nodes` | `40000` | [0, 10⁸] | In `auto`, worlds below this and the edge threshold stay on the CPU |
| `compute.gpu_thresholds.min_edges` | `150000` | [0, 10⁸] | See above |

`bus_stops.*`, `traffic.*`, `ui.osm_background` and `logging.*` are
informational: stop spacing is 300 m minimum, 500 m target and 800 m coverage,
logs go to `<logs>/system.log` and `<logs>/runtime.db`.

## Start request fields

What `POST /api/v1/playback/start` and `/prepare` accept (the CLI builds this):

| Field | Type | Rule |
|---|---|---|
| `seed` | number or string | Decimal, `0x` hex (up to 128 bits), `auto`, `random`, `""` or `0` (fresh seed) |
| `day` | 0, 1, `"weekday"`, `"weekend"` or `"auto"` | Absent or `auto`: the seed's own day type. Before 2.3 an absent day meant weekday |
| `month` | 1 to 12, a month name, or `"auto"` | Absent or `auto`: the seed's own month. A given value is recorded as configured |
| `playback_duration_seconds` (alias `simulation_time`) | integer | [60, 3600] |
| `tick_rate` | number | (0, 5] |
| `start_virtual_time` | seconds or `HH:MM:SS` | [0, 86400] |
| `map.osm_file` | string | Path or `auto` (the default when there is no `fixture`) |
| `map.max_nodes`, `map.city_extent_m`, `map.district_nodes`, `map.cache_dir` | | As in the table above |
| `modules.{traffic,signals,buildings,dws,flooding,news}` | boolean | `traffic_demand` and `traffic_signals` are accepted as aliases |
| `modules.dcm` | boolean | The Sun and surface model ([DCM](../concepts/solar.md)); default on |
| `modules.hydrology` | boolean | [Surface water](../concepts/surface-water.md); default on. Off: roads use the node flood model |
| `modules.dds` | boolean | [Drainage](../concepts/drainage.md): street water enters a synthetic pipe network; default on, needs `hydrology` |
| `modules.das` | boolean | [Urban wind](../concepts/wind.md): the wind over the buildings, road headwinds, storms drifting downwind; default on |
| `modules.vehicle_dynamics` | boolean | [Grade](../concepts/vehicle-dynamics.md) slows traffic uphill; default on |
| `dws.frequency` | integer | As above |
| `fixture.grid_width`, `fixture.grid_height` | integer | Synthetic grid for tests; at least 3 × 3, and width × height ≤ `max_nodes` |
| `saved_seed_id` | string | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| `environment.dem` | string | `auto`, `terrarium`, `flat` or `synthetic:slope|bowl|hill|valley[:parameter]`; see [Terrain](../concepts/terrain.md#sources) |
| `environment.dem_required` | boolean | Stop the run if terrain cannot be loaded, instead of falling back to flat |
| `environment.grid_cell_m` | number | [2, 1000], default 25: the environment grid's cell size |
| `environment.grid_margin_m`, `environment.max_grid_cells` | | Default 150 m and 262,144 cells ([16, 4,194,304]) |
| `environment.dem_smoothing_passes` | integer | [0, 8], default 1: binomial passes over observed elevation |
| `environment.grade_baseline_m` | number | [0, 2000], default 100: the shortest run a road grade is measured over |
| `map_selection_version` | string | `urban-crfg-v3` |

## CLI flags

```
./launcher start [--seed N | --saved-seed ID] [--save-seed ID [--description TEXT]]
                 [--day-type auto|weekday|weekend] [--location CITY] [--month MONTH]
                 [--duration 60-3600] [--speed 0.01-5]
                 [--max-nodes 2-50000] [--osm-file PATH] [--no-open]
                 [--compute auto|cpu|vulkan] [--gpu-device SPEC]
./launcher diagnostics [gpu]
./launcher bootstrap [--check] [--yes] [--profile minimal|standard|full]
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
             [--map-cache keep|prune|clear] [--map-cache-keep N]
             [--compute auto|cpu|vulkan] [--gpu-device SPEC] [--require-vulkan]
             [--allow-software-vulkan] [--compute-verify] [--vulkan-validation]
             [--compute-cache DIR] [--gpu-diagnostics] [--version] [--help]
```

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | Bind address; `0.0.0.0` exposes the API to the network |
| `--port` | `8090` | Listen port; values outside 1 to 65535 are refused |
| `--logs` | `logs` | System log, SQLite journal, `operator.token`, `global_view.json` |
| `--maps` | `data/maps` | Map cache swept at start-up |
| `--map-cache` | `prune` | `keep` nothing removed; `prune` keep the newest N extracts; `clear` remove all. Interrupted downloads (`.part`) and stale progress files (`.progress`) are always removed |
| `--map-cache-keep` | `1` | N for `prune` |
| `--compute` and the other compute flags | | See [Command-line tools](../reference/command-line-tools.md#dstns_server) |

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
| `DSTNS_COMPUTE_BACKEND`, `DSTNS_GPU_DEVICE`, and the other compute variables | server | See [Environment variables](../reference/environment-variables.md#compute) |

## Observer configuration

`config/ui-config.json` sets the observer's starting state (clock format,
layers, Auto Focus, notifications, Do Not Disturb, playback intervals). The
server serves it at `GET /api/v1/system/ui-config`; a malformed file is
reported and the observer falls back to built-in defaults. Every key, its
range and its default is documented in [Observer
configuration](observer-configuration.md).

## Terrain environment variables

| Variable | Meaning |
|---|---|
| `DSTNS_DEM_SOURCE` | What `environment.dem: auto` means: `flat` keeps a run offline (the test suites set it), `terrarium` uses terrain tiles even for a pinned map |
| `DSTNS_DEM_CACHE` | The terrain tile cache, as `dstns_server --dem-cache DIR` sets it (default `data/dem`) |
| `DSTNS_DEM_ENDPOINT` | URL template for terrain tiles (`{z}`, `{x}`, `{y}`), e.g. a private mirror |
| `DSTNS_HYDROLOGY_GPU_MIN_CELLS` | Grids at least this large run the surface water on a Vulkan device in `auto` mode (default 131,072) |
