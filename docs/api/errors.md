# API errors and status codes

Every error response has the same shape:

```json
{
  "ok": false,
  "api_version": "1.0",
  "error": { "code": "INVALID_REQUEST", "message": "tick_rate must be finite and in (0,5]" }
}
```

`code` is stable and meant for programs; `message` is meant for people and may
change. Handlers validate by throwing, and one exception handler in
`src/api.cpp` maps each exception type to a status and code, so the same kind
of failure always looks the same whichever route raised it.

## Status codes

| Status | When |
|---|---|
| 200 | Success |
| 202 | Accepted and continuing in the background: start, world regeneration, weather, traffic overlay, surge |
| 400 | The request is malformed or a value is out of range |
| 403 | The request is refused: missing operator credential, cross-site write, regeneration disabled |
| 404 | Unknown route, or an unknown node or edge by ID |
| 409 | The request is valid but the run's state does not allow it |
| 410 | A retired route |
| 421 | `Host` not accepted: DNS-rebinding guard on a loopback-bound server |
| 500 | An unexpected failure, including SUMO failures |
| 503 | The seed's map could not be downloaded; retryable |

## Codes

| Code | Status | Raised when |
|---|---|---|
| `INVALID_JSON` | 400 | The body is not valid JSON |
| `MISSING_FIELD` | 400 | A required member is absent, e.g. `target_time` on seek |
| `INVALID_FIELD_TYPE` | 400 | A member has the wrong JSON type, e.g. a string where a number is expected |
| `INVALID_REQUEST` | 400 | A value breaks a rule: out of range, an ID that does not fit 32 bits, a negative query number, an unknown module or catalog, a bad seed. See [Request validation](../deployment/security.md#request-validation) |
| `CLI_START_REQUIRED` | 403 | `start` or `prepare` without the operator credential |
| `CROSS_ORIGIN_FORBIDDEN` | 403 | A state-changing request from a browser page on another origin. See [Security](../deployment/security.md#origin-check-cross-site-request-forgery) |
| `HOST_NOT_ALLOWED` | 421 | The server is bound to loopback and the `Host` header is not `localhost`, a `*.localhost` name or an IP address (DNS rebinding guard). Admit a name with `DSTNS_ALLOWED_HOSTS`. See [Security](../deployment/security.md#host-check-dns-rebinding) |
| `WORLD_REGENERATION_DISABLED` | 403 | `DSTNS_DISABLE_WORLD_REGENERATION=1` is set |
| `NOT_FOUND` | 404 | `/view/nodes/{id}` or `/view/edges/{id}` beyond the graph |
| `LIFECYCLE_CONFLICT` | 409 | E.g. play when not paused, start while a run is active, a second regeneration, step at 24:00:00, seek while terminating, a stale playback guard or `expected_run_id`, SUMO without an active run |
| `TRANSIT_API_RETIRED` | 410 | `POST /api/v1/control/transit/route` |
| `INTERNAL_ERROR` | 500 | Anything else, including `SUMO simulation engine not found`, `Failed to build SUMO network` and `SUMO simulation failed` |
| `MAP_FETCH_FAILED` | 503 | The seed's district could not be downloaded; the message names the city, coordinates and cause |
| `UI_CONFIG_INVALID` | 500 | `config/ui-config.json` is not valid JSON (the observer falls back to defaults) |

World generation failures are not HTTP errors: `POST /world/regenerate`
returns 202, and the job's outcome appears in `GET /world/status` as
`error.code` `MAP_FETCH_FAILED`, `WORLD_GENERATION_FAILED` or
`WORLD_CANCELLED`.

## Handling errors in a client

- Retry 503 `MAP_FETCH_FAILED` after a delay; nothing else is worth retrying
  unchanged.
- On 409, re-read `/playback/status` and decide again; the run moved on.
- Treat 400 as a bug in the request, and show `message` to whoever wrote it.
- A response that is not JSON at all comes from something in front of the
  server (a proxy, a gateway timeout); report its status.
