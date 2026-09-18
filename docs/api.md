# Supported DSTNS API

Version prefix remains `/api/v1`; read views retain `{api_version, run_id, global_seed, state_revision, config_revision, clock, data}`. `clock.simulation_percentage` is a **fraction in [0,1]**, preserved for compatibility. Clients multiply by 100 for a percentage display.

| Method | Route | Behavior |
|---|---|---|
| GET | `/health`, `/api/v1/system/health` | Liveness/lifecycle |
| GET | `/api/v1/system/info` | Product and optional SUMO availability |
| GET | `/api/v1/playback/status` | Lifecycle, clock, day, saved seed ID, map version, modules |
| POST | `/api/v1/playback/start` | CLI operator credential required; HTTP 202 |
| POST | `/api/v1/playback/pause`, `/play` | Pause/resume active run |
| PUT | `/api/v1/control/tick-rate` | Validated positive rate, at most 100 |
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

**Retired compatibility behavior:** `POST /api/v1/control/transit/route` returns HTTP 410 / `TRANSIT_API_RETIRED`. It is not part of the supported API. Internal route planning remains unchanged. Legacy `/api/v1/view/events` retains its weather-catalog response; new event consumers must use `event-queue`.

See [model and migration details](modernization.md), including the aggregate-model/SUMO boundary and history retention.
