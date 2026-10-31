# Fabric

![Fabric](../assets/brand/fabric-black.png#only-light){ width="150" }
![Fabric](../assets/brand/fabric-white.png#only-dark){ width="150" }

Fabric is the layer through which everything reaches DSTNS: the HTTP API, and the
registry of applications built on it. Source: `Fabric/`, as the `dstns_fabric`
library, which depends on `dstns_core`. The core never depends on Fabric.

## Layout

| File in `Fabric/src/` | Owns |
|---|---|
| `api.cpp` | `ApiServer`: construction, listening and stopping |
| `guards.cpp` | What every request passes: the `Host` and `Origin` checks, the operator credential, CORS, and mapping exceptions to error codes |
| `support.cpp` | Parsing shared by the route modules |
| `operations.cpp` | Control operations shared by the public routes and the application route, so both validate alike |
| `routes_static.cpp` | The observer's page, assets and icon |
| `routes_system.cpp` | Identity, health, licence, map status, backpressure, shutdown |
| `routes_playback.cpp`, `routes_world.cpp` | Moving through time; replacing the world |
| `routes_control.cpp` | Acting on the running simulation |
| `routes_view.cpp` | Reading the world and its state |
| `routes_observation.cpp` | News, logs and event streams |
| `routes_apps.cpp`, `registry.cpp` | Applications; see the [Fabric API](../api/fabric-api.md) |

To add a route, add it to the module for its group and to the index in
`routes_system.cpp`, which is served at `/api/v1/system/endpoints`.

## Compatibility

Moving the API under Fabric changed no endpoint, schema or behaviour. That is tested,
not assumed: `tests/api/fabric_contract_smoke.py` replays 155 calls against a baseline
recorded from the server before the move, covering reads before and during a run,
writes, aliases and refusals. A status, content type or recorded header must match,
and every recorded response key must still exist with the same type. New routes and
new keys are allowed, as the [compatibility promise](../api/versioning.md) says.

Applications are additive. A client that has never heard of them sees the same API,
with `api_version` raised from `1.0` to `1.1` to say that routes were added.

## Licence

Fabric is part of DSTNS, © 2026 Varun Karthic, under
[AGPL-3.0-or-later](../license.md).
