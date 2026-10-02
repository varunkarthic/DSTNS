# Supported DSTNS API

Version prefix remains `/api/v1`; read views return `{api_version, run_id, seed, global_seed, state_revision, config_revision, clock, data}`. `seed` is the run's decimal seed, the number an operator types and reads back; `global_seed` is the same value in the internal hexadecimal form used for hashing and sub-seed derivation. `clock.simulation_percentage` is a **fraction in [0,1]**, preserved for compatibility. Clients multiply by 100 for a percentage display.

| Method | Route | Behavior |
|---|---|---|
| GET | `/health`, `/api/v1/system/health` | Liveness/lifecycle |
| GET | `/api/v1/system/info` | Product and optional SUMO availability |
| GET | `/api/v1/playback/status` | Lifecycle, clock, day, calendar (location, month, day type and their sources), saved seed ID, map version, modules |
| POST | `/api/v1/playback/start` | CLI operator credential required; HTTP 202, preparation/download continues in the background and is observed through status/map-status |
| POST | `/api/v1/playback/pause`, `/play` | Pause/resume active run |
| POST | `/api/v1/playback/seek` | Move to `target_time` (seconds or `HH:MM:SS`); earlier times restore a checkpoint and replay |
| POST | `/api/v1/playback/step` | Advance `seconds` (1 to 3600, default 60) of virtual time and hold paused |
| POST | `/api/v1/world/regenerate` | Replace the world with one from a fresh secure seed, or from `seed` (a decimal string) when given; HTTP 202, progress via `/world/status` |
| GET | `/api/v1/seeds/locations` | The 181-city catalogue a seed draws its location from |
| GET | `/api/v1/seeds/describe?seed=N` | The location, month and day type seed `N` resolves to; 400 without `seed` |
| POST | `/api/v1/seeds/generate` | A fresh seed whose own `location`, `month` and `day_type` match the body (each optional or `"auto"`); 400 for an unknown city or month |
| GET | `/api/v1/world/status` | State of the current or last world generation job |
| GET | `/api/v1/system/observer` | Whether the observer page has been served yet, and how many times |
| PUT | `/api/v1/control/tick-rate` | Rate in (0, 5]; the interface offers 0.25, 0.5, 1, 2, 3 and 5 |
| GET | `/api/v1` , `/api/v1/system/endpoints` | Machine-readable index of every group and route |
| GET | `/api/v1/view/topology` | Immutable geographic graph, road names/tags, features, bounds, projection |
| GET | `/api/v1/view/places`, `/api/v1/places` | Classified places with live demand and the couplings acting on them |
| GET | `/api/v1/view/place-kinds` | The place taxonomy, what is modelled, and this world's counts |
| GET | `/api/v1/view/stops` | Bus stops, thinned to realistic route spacing |
| GET | `/api/v1/view/snapshot` | Dynamic roads, signals, demand, weather, actual incidents, congestion |
| GET | `/api/v1/view/congestion` | Current/average/delta and minute-sampled history |
| GET | `/api/v1/view/event-queue` | Paginated future or executed events |
| GET | `/api/v1/view/signals` | Current independent controller state |
| GET | `/api/v1/view/traffic`, `/metrics`, `/weather`, `/buildings`, `/bus-stops`, `/incidents` | Existing domain views |
| GET | `/api/v1/view/manifest`, `/global` | Reproducibility manifest and comprehensive view |
| GET | `/api/v1/news?since_news_id=0&limit=100` | Important activity notifications |
| GET | `/api/v1/view/stream`, `/api/v1/news/stream` | Existing SSE transport |
| POST | `/api/v1/export/sumo`, `/api/v1/system/sumo-simulate` | Batch SUMO adapter: export a bundle, or export, build and run SUMO for `begin_s < end_s <= 86400`. See [SUMO adapter](../components/sumo-adapter.md) |
| PUT, POST | `/api/v1/control/...` | Day, modules, edge overrides, signals, weather, surges, undo and redo. See [Control API](control-api.md) |
| POST | `/api/v1/system/terminate` | Stop the run and exit the process (POST only) |

`event-queue` accepts `view=future|history`, `category=all|signals|demand|incidents|weather|flooding|system`, `offset=0..100000`, `limit=1..200`. It returns `items`, filtered `total`, `pending_count`, `executed_count`, and `history_retention`. Events contain stable execution sequence IDs, category, entity, virtual second, description, status and state value. Future flooding is not predicted; actual flood threshold crossings appear in history.

Startup uses `X-DSTNS-Operator` from the private local CLI credential. No browser startup key is exposed. Missing/incorrect startup credentials return HTTP 403 with `CLI_START_REQUIRED`. The payload supports `saved_seed_id` and `map_selection_version=urban-crfg-v3` in addition to existing configuration. Saved seed creation/deletion remains local CLI functionality rather than a public mutation API.

Initial preparation is accepted before scenario compilation begins. While the map is
being selected, downloaded and compiled, `GET /api/v1/playback/status` reports
`PREPARING` and `GET /api/v1/system/map-status` reports the current fetch phase
and byte progress. The operator CLI waits for the terminal lifecycle; the
observer can remain responsive and narrate the work throughout.

Operator stop/reset/seek, world controls, module controls, history/undo/redo and log routes remain available; the observer uses none of the world-editing controls. They are documented in [Playback API](playback-api.md) and [Control API](control-api.md). Undo is logical: it restores a control's value from now on and is not a physical replay.

## Security and validation

- **Starting runs** needs the CLI's operator credential (`X-DSTNS-Operator`), or HTTP 403 `CLI_START_REQUIRED`.
- **Cross-site writes are refused.** Any request other than `GET`, `HEAD` or `OPTIONS` that carries a browser `Origin` must come from the host it was sent to, or from an origin in `DSTNS_ALLOWED_ORIGINS`; otherwise HTTP 403 `CROSS_ORIGIN_FORBIDDEN`. Clients that are not browsers send no `Origin` and are unaffected.
- **Shutdown is `POST` only**: `POST /api/v1/system/terminate` (or `POST /terminate`).
- **Numbers are range-checked, never wrapped.** Path IDs must fit 32 bits; times are in [0, 86400]; query numbers must be unsigned decimals; undo and redo counts are in [1, 10000]. Every rule is listed in [Security](../deployment/security.md#request-validation).

Error responses and codes are listed in [API errors](errors.md).

## Discovery

`GET /api/v1` returns the API describing itself: every group, every route and one
line on what each is for. A client that has the base URL needs nothing else to
find its way around, and the index cannot drift from the server the way a
document can. `GET /api/v1/system/endpoints` returns the same payload.

## Places

The world is more than a road graph. `GET /api/v1/view/places` returns every
mapped place the demand model reasons about, classified into a fixed taxonomy
and carrying its live demand:

```json
{
  "id": "node/12108766525",
  "name": "Camden Street",
  "kind": "bus_stop",
  "modelled": true,
  "generator": false,
  "commercial": false,
  "position": { "x_m": 412.7, "y_m": -883.1, "lat": 53.3371, "lon": -6.2653 },
  "anchor_node": 1884,
  "demand": {
    "multiplier": 1.42,
    "baseline": 1.18,
    "factors": [ { "cause": "stop follows nearby demand", "multiplier": 1.21 } ],
    "radius_m": 400.0
  }
}
```

`multiplier` is what the place is drawing now; `baseline` is what its schedule
alone asked for; `factors` decomposes the difference into the named couplings
that produced it, so any figure on screen can be explained rather than trusted.
`?kind=` narrows to one kind and `?offset=`/`?limit=` page the result (limit caps
at 2000, default 500). `total` counts what matched the filter, not the world.

`GET /api/v1/view/place-kinds` returns the taxonomy itself - every kind the
classifier can produce, whether the demand model speaks for it, and how many of
each this world holds. Kinds that are not modelled (`residential`, `worship`,
`other`) sit at 1.0 for the whole run and are hidden from the places legend by
default.

### Stops

`GET /api/v1/view/stops` is `places?kind=bus_stop`, so a transit client need not
learn the taxonomy to ask the obvious question.

OpenStreetMap records a stop per kerb, per platform and per operator, so one
place on the ground can arrive as half a dozen nodes metres apart. Stops are
therefore thinned on load, against the street each one serves: stops sharing a
corridor are held at least 300 m apart, the spacing a real route uses, while two
stops on parallel streets only have to clear 60 m, because they are two stops
serving two corridors. Where a cluster is collapsed, the best-attested member
survives - a named station outranks a named stop, which outranks an unnamed
node - and ties break on feature id, so the same extract always thins to the
same stops.

## Stepping

`POST /api/v1/playback/step` with `{"seconds": 60}` advances the model by exactly
that many virtual seconds using the same one-second physics as normal playback,
then leaves the run `PAUSED`. The response reports `from_seconds`,
`simulated_seconds`, `stepped_seconds`, `lifecycle` and `playback_revision`.
A step that reaches 24:00:00 completes the run (`COMPLETED`); stepping a
completed day returns HTTP 409. `seconds` outside 1 to 3600 returns HTTP 400
`INVALID_REQUEST`. Stepping and seeking to the same time produce identical
state.

## Seeds

A seed is a 128-bit number and is written as a decimal integer everywhere an
operator sees it. `POST /api/v1/playback/start` and `/prepare` accept it as a
JSON number, as a decimal string, or as `0x...` for the internal hexadecimal
form; `auto`, `random`, an empty string or `0` draw a fresh 64-bit seed, short
enough to read off the screen and retype. Responses report both forms: `seed`
(decimal) names the run, `global_seed`/`seed_hex` carries the hexadecimal one.

## World selection

`map.osm_file: "auto"` resolves the seed to a real place through the
`urban-crfg-v3` map selection: one of 181 urban centres across every inhabited
continent, then a district anchor inside that city's extract. The catalogue and
its order are part of the version, so seeds saved under an earlier version are
rejected rather than silently resolving somewhere else.

## World regeneration

`POST /api/v1/world/regenerate` accepts an optional `{"expected_run_id": "..."}`
guard and returns HTTP 202 with the job status immediately. The caller cannot
choose anything about the new world: the seed comes from the secure generator
and every other parameter is copied from the run the operator started, so
scenario configuration stays with the CLI. For a seed-selected map the new seed
chooses its own district (a map download may follow); an operator-pinned map
file stays pinned.

Requesting a new world pauses the current one first, so nothing is computed
against a world that is being replaced. The new world is then compiled without
holding the engine lock, and the old one is left completely unchanged if
generation fails. The swap is atomic and a regenerated world starts `PAUSED` at
00:00:00 with the operator's requested speed.

Adaptive Simulation Backpressure ignores what the observer reports while a
world is being prepared, and for three seconds after the swap: lag measured
across a world change describes the world that has gone, not an interface
failing to keep up.

`GET /api/v1/world/status` returns:

| Field | Meaning |
|---|---|
| `state` | `idle`, `generating`, `ready` or `failed` |
| `stage` | `compiling`, `requesting`, `downloading`, `validating`, `building`, `installing`, `ready` or `failed`. Map stages come from the live downloader |
| `seed` | The new decimal seed, available as soon as the request is accepted |
| `seed_hex` | The same seed in the internal hexadecimal form |
| `previous_run_id`, `run_id` | The world replaced, and the world installed |
| `map` | While downloading: `city`, `country`, `phase`, `bytes`, `total` (0 when unknown), `elapsed_s` |
| `error` | On failure: `{code, message}`; `MAP_FETCH_FAILED` or `WORLD_GENERATION_FAILED` |
| `elapsed_s`, `generation` | Job duration and a counter distinguishing jobs |
| `enabled` | False when the operator disabled regeneration |

A second request while one is generating, or with a stale `expected_run_id`,
returns HTTP 409 `LIFECYCLE_CONFLICT`. Operators can disable the endpoint with
`DSTNS_DISABLE_WORLD_REGENERATION=1`, which returns HTTP 403
`WORLD_REGENERATION_DISABLED`.

`GET /api/v1/system/observer` reports `{loaded, loads}`. The launcher opens the
interface and waits for this before requesting a run, so world selection, the
map download, generation and initialization are all watched in the interface
rather than happening behind a blank tab. It counts page loads only and carries
no session identity.

`GET /api/v1/system/map-status` reports the live map download and, in
`preparation`, what a compile is doing when no map is moving: `selecting`
(resolving the seed to a place), `acquiring` (obtaining its map) or `building`
(constructing the graph, signals and schedules). It is empty when nothing is
being compiled, and it is readable while a compile holds the engine lock, which
is what lets the interface narrate start-up.

### Retired and compatibility routes

| Route | Status |
|---|---|
| `POST /api/v1/control/transit/route` | Retired. Returns HTTP 410 with `TRANSIT_API_RETIRED`; internal route planning is unaffected |
| `GET /api/v1/view/events` | Kept for compatibility; returns the weather catalogue. New clients should use `/api/v1/view/event-queue` |

The boundary between the live aggregate model and the SUMO adapter is described in
[Model scope and assumptions](../concepts/model-scope.md); event history retention is
listed in [Limits and ranges](../reference/limits.md#api-paging-and-retention).
