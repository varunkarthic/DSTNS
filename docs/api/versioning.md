# Versioning

| What | Version | Where reported |
|---|---|---|
| The API contract | `1.0`, under the `/api/v1` prefix | `api_version` in responses |
| The engine | `2.0.0` | `version` in `/health` and `/system/info` |
| The observer | `2.2.0` | About |
| Map selection | `urban-crfg-v3` | `map_selection_version` |
| Algorithms | `DSTNS/1` | `/view/manifest` |

## Compatibility promise

Within `/api/v1`:

- Routes, request fields and response fields are not removed or renamed.
- New routes and new response fields may be added; clients must ignore fields
  they do not know.
- Error `code`s are stable; `message`s are not.
- A route that is retired keeps answering with HTTP 410 and a code, as
  `POST /control/transit/route` does with `TRANSIT_API_RETIRED`.

A breaking change would introduce `/api/v2` alongside `/api/v1`.

## Changes that are not breaking but matter

Some fixes change behaviour that a client might have relied on. They are
listed in the [changelog](../changelog.md). The ones to know:

- **October 2026:** `GET /terminate` and `GET /api/v1/system/terminate` were
  removed (use `POST`); state-changing requests from other browser origins are
  refused; out-of-range IDs, times and counts that used to wrap are refused
  with 400.

## Aliases

Convenience paths map to canonical ones and are kept for compatibility:
`/health` (`/api/v1/system/health`), `POST /stop` (`/api/v1/playback/stop`),
`POST /terminate` (`/api/v1/system/terminate`), `/api/v1/topology`,
`/api/v1/places`, and the view aliases listed in [View API](view-api.md#routes).

## Simulation results across versions

The [reproducibility guarantee](../concepts/reproducibility.md) holds for one
DSTNS version. A version that fixes a modelling or parsing bug can change
results for affected maps; the changelog says which.
