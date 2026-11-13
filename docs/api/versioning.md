# Versioning

| What | Version | Where reported |
|---|---|---|
| The API contract | `1.6`, under the `/api/v1` prefix | `api_version` in responses |
| The engine | `3.3.2` | `version` in `/health` and `/system/info` |
| The observer | `3.1.0` | About |
| Map selection | `urban-crfg-v3` (default), `urban-geo-v1` (core-ng) | `map_selection_version`; `map_selection` in `/view/manifest` with the policy's fingerprint |
| Engines | `core-legacy`, `core-ng` | `engine` in status and `/view/manifest`; `engines` in `/system/info` |
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

Additions raise the minor version of the contract. `1.1` added the
[Fabric API](fabric-api.md); nothing that existed in `1.0` changed. `1.2` raises the
highest accepted `tick_rate` from 5 to 10. `1.3` added subscriptions, timers, per-application storage, messages,
atomic interface batches, health, discovery, and the engine's controls under `/api/v1/fabric/engine`, with security around
them. `1.4` added directing the view: `ui.camera`, `ui.layers`, and path styles and colours. `1.5` added the `engine`
field to the start request, playback status and manifest, and `engines` to `/system/info`. `1.6` added
`map_selection` to the start request and the manifest, and accepts `urban-geo-v1` with engine `core-ng`.

## Security exceptions

The compatibility promise yields to security. Behaviour that is itself a
vulnerability may be removed or restricted within `/api/v1`, and every such change is
listed under **Security** in the [release notes](../changelog.md). The changes made so
far:

| Change | Reason | Client action |
|---|---|---|
| `GET /terminate` and `GET /api/v1/system/terminate` removed; shutdown is `POST` only | A GET can be triggered by any web page through an image tag | Use `POST` |
| `directory` on `POST /export/sumo` and `/system/sumo-simulate` must be under `data/` without the operator credential | A client controlling a simulation could otherwise have files written anywhere the server's user can | Use a path under `data/`, or send `X-DSTNS-Operator` |
| Request bodies are limited to 16 MiB and 64 levels of JSON | A deeply nested request crashed the server, and a large one had no limit | Send less |
| An application's storage and queued events don't pass to whoever takes up its ID without its token | They could be read by anyone once it had gone | Keep your token |
| State-changing requests from other browser origins refused with 403 `CROSS_ORIGIN_FORBIDDEN` | Cross-site request forgery | Add trusted origins to `DSTNS_ALLOWED_ORIGINS` |
| Unknown `Host` names on a loopback server refused with 421 `HOST_NOT_ALLOWED` | DNS rebinding | Add names to `DSTNS_ALLOWED_HOSTS` |
| Out-of-range IDs, times and counts refused with 400 instead of wrapping | They silently acted on the wrong object | Send values within the documented ranges |

## Aliases

Convenience paths map to canonical ones and are kept for compatibility:
`/health` (`/api/v1/system/health`), `POST /stop` (`/api/v1/playback/stop`),
`POST /terminate` (`/api/v1/system/terminate`), `/api/v1/topology`,
`/api/v1/places`, and the view aliases listed in [View API](view-api.md#routes).

## Map selection policies

A policy ID never changes meaning. `urban-crfg-v3` resolves every seed exactly as engine 3.0 did, on both engines.
A policy that chooses differently gets a new ID. A seed alone identifies an `urban-crfg-v3` world; a world chosen
under `urban-geo-v1` is identified by its seed, its policy and the policy's fingerprint, all in the manifest.

## Simulation results across versions

The [reproducibility guarantee](../concepts/reproducibility.md) holds for one
DSTNS version. A version that fixes a modelling or parsing bug can change
results for affected maps; the changelog says which.

## Container build identity

The semantic engine version is separate from the release channel (`stable`,
`edge`, or `local`). `/api/v1/system/info` reports the exact source revision, UTC
build time, channel, build type and architecture under `build`, alongside the
compiler and C++ standard. The same revision/channel appear in
`dstns_server --version`; container labels and `/app/build-info.json` also record
image identity. Pin the GHCR image digest for exact reruns; see
[container tags](../deployment/docker.md#tags-and-build-identity).
