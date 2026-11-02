# API errors and status codes

Every error response has the same shape:

```json
{
  "ok": false,
  "api_version": "1.4",
  "error": { "code": "INVALID_REQUEST", "message": "tick_rate must be finite and in (0,20]" }
}
```

`code` is stable and meant for programs; `message` is meant for people and may
change. Handlers validate by throwing, and one exception handler in
`Fabric/src/` maps each exception type to a status and code, so the same kind
of failure always looks the same whichever route raised it.

## Status codes

| Status | When |
|---|---|
| 200 | Success |
| 202 | Accepted and continuing in the background: start, world regeneration, weather, traffic overlay, surge |
| 400 | The request is malformed or a value is out of range |
| 401 | An application's token is missing or wrong, or a signature is missing, wrong, old or used |
| 403 | The request is refused: missing operator credential, cross-site write, regeneration disabled, a capability not granted |
| 404 | Unknown route, or an unknown node or edge by ID |
| 409 | The request is valid but the run's state does not allow it |
| 410 | A retired route |
| 421 | `Host` not accepted: DNS-rebinding guard on a loopback-bound server |
| 413 | The body or what it would store is too large |
| 422 | Valid, but it doesn't fit this world: a junction or road that isn't there, or a version it can't serve |
| 429 | Too many: slow down, and send again |
| 500 | A fault in the server |
| 503 | A tool or service outside the server failed: the seed's map couldn't be downloaded, or SUMO failed |

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
| `INTERNAL_ERROR` | 500 | Anything else, which is a fault in the server. Once: `SUMO simulation engine not found`, `Failed to build SUMO network` and `SUMO simulation failed` |
| `MAP_FETCH_FAILED` | 503 | The seed's district could not be downloaded; the message names the city, coordinates and cause |
| `UI_CONFIG_INVALID` | 500 | `config/ui-config.json` is not valid JSON (the observer falls back to defaults) |

### Applications

| Code | Status | Raised when |
|---|---|---|
| `INVALID_MANIFEST` | 400 | A manifest field is missing or breaks a rule. The message names it |
| `INVALID_ELEMENT` | 400 | A declared element or overlay feature breaks a rule |
| `INVALID_NOTIFICATION`, `INVALID_SETTINGS`, `INVALID_TOPICS`, `INVALID_TIMER`, `INVALID_MESSAGE`, `INVALID_STOPS`, `INVALID_LAUNCH`, `INVALID_VIEW`, `INVALID_PRESENTATION` | 400 | That kind of request breaks a rule |
| `UNKNOWN_ACTION` | 400 | `/control` with an action there isn't |
| `CAPABILITY_NOT_REQUESTED` | 400, 403 | Granting, or using, something the manifest doesn't ask for |
| `APP_TOKEN_INVALID` | 401 | No token, or the wrong one |
| `SIGNATURE_REQUIRED` | 401 | The application requires signed requests, and this isn't one |
| `SIGNATURE_INVALID`, `SIGNATURE_EXPIRED`, `SIGNATURE_REPLAYED` | 401 | It doesn't match; its time is over 60 s out; its nonce has been used |
| `APP_ID_RESERVED`, `APP_NAME_RESERVED` | 403 | IDs may not start with `dstns`, `fabric` or `webfabric`, and names may not be them |
| `CAPABILITY_NOT_GRANTED` | 403 | A person hasn't allowed this, or has stopped allowing it |
| `HOST_REQUIRED` | 403 | Only the observer or the operator may do this |
| `AUTHORIZATION_REQUIRED` | 403 | A change under `/api/v1/fabric/engine/` from anyone else |
| `FRAME_ORIGIN_NOT_DECLARED` | 403 | A frame from somewhere not in `frame_origins` |
| `RECIPIENT_NOT_LISTENING` | 403 | The other application doesn't accept messages |
| `DIRECTORY_NOT_ALLOWED` | 403 | Only the operator may have files written outside `data/` |
| `APP_NOT_FOUND`, `ELEMENT_NOT_FOUND`, `KEY_NOT_FOUND`, `TIMER_NOT_FOUND`, `PROPOSAL_NOT_FOUND` | 404 | No such thing |
| `APP_ID_CONFLICT` | 409 | That ID is in use, or holds grants, and no token was presented |
| `APP_NOT_ACTIVE`, `APP_SUSPENDED` | 409 | It's been suspended, has failed or has gone |
| `CAPABILITY_DISABLED`, `APPLICATIONS_DISABLED`, `LAUNCH_PROPOSALS_DISABLED` | 403 | The operator has turned that off on this server |
| `LEGACY_API_DISABLED` | 410 | The operator has turned the older routes off. Use `/api/v1/fabric/engine` |
| `UI_TOO_LARGE`, `STORAGE_FULL`, `TOO_MANY_TIMERS`, `MESSAGE_TOO_LARGE` | 413 | Over a [limit](security.md#limits) |
| `APP_INCOMPATIBLE` | 422 | The manifest needs a version this server doesn't provide |
| `NOT_ON_NETWORK` | 422 | A junction or road that isn't in this world, or nodes that aren't joined by a road |
| `RATE_LIMITED` | 429 | Too many notifications, messages or changes to the view |
| `APP_LIMIT_REACHED`, `TOO_MANY_PROPOSALS` | 429 | 64 applications, none of which can make way; 64 proposals waiting |
| `SUMO_FAILED` | 503 | SUMO failed, or its files couldn't be written |

World generation failures are not HTTP errors: `POST /world/regenerate`
returns 202, and the job's outcome appears in `GET /world/status` as
`error.code` `MAP_FETCH_FAILED`, `WORLD_GENERATION_FAILED` or
`WORLD_CANCELLED`.

## Handling errors in a client

- Retry 503 `MAP_FETCH_FAILED` after a delay; nothing else is worth retrying
  unchanged.
- On 409, re-read `/playback/status` and decide again; the run moved on.
- On 429, wait and send again. On 401 from a signed request, check the clock.
- Treat 400 as a bug in the request, and show `message` to whoever wrote it.
- A response that is not JSON at all comes from something in front of the
  server (a proxy, a gateway timeout); report its status.
