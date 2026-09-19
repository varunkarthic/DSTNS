# Supported DSTNS API

Version prefix remains `/api/v1`; read views retain `{api_version, run_id, global_seed, state_revision, config_revision, clock, data}`. `clock.simulation_percentage` is a **fraction in [0,1]**, preserved for compatibility. Clients multiply by 100 for a percentage display.

| Method | Route | Behavior |
|---|---|---|
| GET | `/health`, `/api/v1/system/health` | Liveness/lifecycle |
| GET | `/api/v1/system/info` | Product and optional SUMO availability |
| GET | `/api/v1/playback/status` | Lifecycle, clock, day, saved seed ID, map version, modules |
| POST | `/api/v1/playback/start` | CLI operator credential required; HTTP 202 |
| POST | `/api/v1/playback/pause`, `/play` | Pause/resume active run |
| POST | `/api/v1/playback/seek` | Move to `target_time` (seconds or `HH:MM:SS`); earlier times restore a checkpoint and replay |
| POST | `/api/v1/playback/step` | Advance `seconds` (1 to 3600, default 60) of virtual time and hold paused |
| POST | `/api/v1/world/regenerate` | Replace the world with one from a fresh secure seed; HTTP 202, progress via `/world/status` |
| GET | `/api/v1/world/status` | State of the current or last world generation job |
| PUT | `/api/v1/control/tick-rate` | Rate in (0, 5]; the interface offers 0.25, 0.5, 1, 2, 3 and 5 |
| GET | `/api/v1/view/topology` | Immutable geographic graph, road names/tags, features, bounds, projection |
| GET | `/api/v1/view/snapshot` | Dynamic roads, signals, demand, weather, actual incidents, congestion |
| GET | `/api/v1/view/congestion` | Current/average/delta and minute-sampled history |
| GET | `/api/v1/view/event-queue` | Paginated future or executed events |
| GET | `/api/v1/view/signals` | Current independent controller state |
| GET | `/api/v1/view/traffic`, `/metrics`, `/weather`, `/buildings`, `/bus-stops`, `/incidents` | Existing domain views |
| GET | `/api/v1/view/manifest`, `/global` | Reproducibility manifest and comprehensive view |
| GET | `/api/v1/news?since_news_id=0&limit=100` | Important activity notifications |
| GET | `/api/v1/view/stream`, `/api/v1/news/stream` | Existing SSE transport |
| POST | `/api/v1/export/sumo`, `/api/v1/system/sumo-simulate` | Explicit batch adapter operations |

`event-queue` accepts `view=future|history`, `category=all|signals|demand|incidents|weather|flooding|system`, `offset=0..100000`, `limit=1..200`. It returns `items`, filtered `total`, `pending_count`, `executed_count`, and `history_retention`. Events contain stable execution sequence IDs, category, entity, virtual second, description, status and state value. Future flooding is not predicted; actual flood threshold crossings appear in history.

Startup uses `X-DSTNS-Operator` from the private local CLI credential. No browser startup key is exposed. Missing/incorrect startup credentials return HTTP 403 with `CLI_START_REQUIRED`. The payload supports `saved_seed_id` and `map_selection_version=urban-crfg-v2` in addition to existing configuration. Saved seed creation/deletion remains local CLI functionality rather than a public mutation API.

Existing operator stop/reset/seek, explicit world controls, module controls, history/undo/redo and log routes remain available; the browser has no clients or controls for world edits. See the implementation for compatibility routes. Do not interpret logical undo of a world override as a complete physical replay.

## Stepping

`POST /api/v1/playback/step` with `{"seconds": 60}` advances the model by exactly
that many virtual seconds using the same one-second physics as normal playback,
then leaves the run `PAUSED`. The response reports `from_seconds`,
`simulated_seconds`, `stepped_seconds`, `lifecycle` and `playback_revision`.
A step that reaches 24:00:00 completes the run (`COMPLETED`); stepping a
completed day returns HTTP 409. `seconds` outside 1 to 3600 returns HTTP 400
`INVALID_REQUEST`. Stepping and seeking to the same time produce identical
state.

## World regeneration

`POST /api/v1/world/regenerate` accepts an optional `{"expected_run_id": "..."}`
guard and returns HTTP 202 with the job status immediately. The caller cannot
choose anything about the new world: the seed comes from the secure generator
and every other parameter is copied from the run the operator started, so
scenario configuration stays with the CLI. For a seed-selected map the new seed
chooses its own district (a map download may follow); an operator-pinned map
file stays pinned.

The new world is compiled without holding the engine lock. The current world
keeps running until the new one is installed, and is left completely unchanged
if generation fails. A regenerated world starts `PAUSED` at 00:00:00 with the
operator's requested speed.

`GET /api/v1/world/status` returns:

| Field | Meaning |
|---|---|
| `state` | `idle`, `generating`, `ready` or `failed` |
| `stage` | `compiling`, `requesting`, `downloading`, `validating`, `building`, `installing`, `ready` or `failed`. Map stages come from the live downloader |
| `seed` | The new seed, available as soon as the request is accepted |
| `previous_run_id`, `run_id` | The world replaced, and the world installed |
| `map` | While downloading: `city`, `country`, `phase`, `bytes`, `total` (0 when unknown), `elapsed_s` |
| `error` | On failure: `{code, message}`; `MAP_FETCH_FAILED` or `WORLD_GENERATION_FAILED` |
| `elapsed_s`, `generation` | Job duration and a counter distinguishing jobs |
| `enabled` | False when the operator disabled regeneration |

A second request while one is generating, or with a stale `expected_run_id`,
returns HTTP 409 `LIFECYCLE_CONFLICT`. Operators can disable the endpoint with
`DSTNS_DISABLE_WORLD_REGENERATION=1`, which returns HTTP 403
`WORLD_REGENERATION_DISABLED`.

**Retired compatibility behavior:** `POST /api/v1/control/transit/route` returns HTTP 410 / `TRANSIT_API_RETIRED`. It is not part of the supported API. Internal route planning remains unchanged. Legacy `/api/v1/view/events` retains its weather-catalog response; new event consumers must use `event-queue`.

See [model and migration details](modernization.md), including the aggregate-model/SUMO boundary and history retention.
