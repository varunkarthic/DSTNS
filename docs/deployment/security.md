# Security

DSTNS is an operator tool. It is meant to run on the operator's own machine,
or on an access-controlled network, and to be watched in a browser. The
bundled TLS gateway adds transport encryption; remote access still requires
network restrictions or an authenticated proxy. This page
states what the server protects against, how, and what an operator has to do
to keep those protections in place.


## Threat model

| In scope | Out of scope |
|---|---|
| A web page the operator visits trying to drive the local API (CSRF) | An attacker with a shell on the host |
| Malformed or hostile request bodies, IDs and query strings | Denial of service by request volume |
| Hostile or corrupted OSM data from the network | Confidentiality of run state (it is not secret) |
| Shell injection through paths passed to external tools | Multi-tenant isolation; one server serves one operator |

The API has no user accounts. Anyone who can reach the port can read run state
and use the playback and control endpoints. Bind to `127.0.0.1` for local use.
For remote use, restrict network access and add authentication at the proxy or
network boundary as well as TLS. The native server defaults to `0.0.0.0`; Compose
publishes 8090 on host interfaces even when the TLS profile is enabled.

## Starting runs: the operator credential

At start-up, `dstns_server` writes a random 256-bit credential to
`<logs>/operator.token` with mode `0600` (or uses `DSTNS_OPERATOR_TOKEN` if
set). `POST /api/v1/playback/start` and `POST /api/v1/playback/prepare` must
present it in `X-DSTNS-Operator`, or they fail with HTTP 403
`CLI_START_REQUIRED`. The CLI reads the file; the browser never sees it. Only
someone with the credential can start or prepare a run. World regeneration is a
separate endpoint available to reachable clients unless disabled; the token is
not a general authorization layer.

## Cross-site request forgery

A browser attaches an `Origin` header to every cross-origin request and to
every same-origin request that is not a `GET` or `HEAD`. The pre-routing guard
in `src/api.cpp` refuses any request with a method other than `GET`, `HEAD` or
`OPTIONS` that carries an `Origin` unless one of these holds:

1. the origin's `host[:port]` equals the request's `Host` header;
2. it equals the first entry of `X-Forwarded-Host` (set by a reverse proxy);
3. the full origin appears in `DSTNS_ALLOWED_ORIGINS`, a comma-separated list
   such as `https://ops.example.org,http://localhost:5173`.

A refused request gets HTTP 403:

```json
{ "ok": false, "error": { "code": "CROSS_ORIGIN_FORBIDDEN",
  "message": "State-changing requests must come from the observer's own origin." } }
```

`Origin: null` (sandboxed frames, some redirects) is always refused. Requests
without an `Origin` (the CLI, `curl`, Python scripts) are not affected,
so this mechanism is not authentication for arbitrary network clients. The
implementation compares origin authority with `Host` or `X-Forwarded-Host`; it
does not enforce full scheme/host/port identity for those host comparisons.
A trusted proxy must overwrite forwarded headers, and clients must not be able
to bypass it to reach the backend.

**Which setups need configuration:**

| Setup | Needs |
|---|---|
| Observer served by `dstns_server` itself | Nothing |
| Vite dev server (`npm run dev`) | Nothing: Vite proxies `/api` and keeps the browser's `Host` |
| Docker gateway | Nothing: `nginx.conf` forwards `X-Forwarded-Host` |
| Your own reverse proxy | Forward `Host`, or set `X-Forwarded-Host` |
| Observer on another origin (`VITE_DSTNS_API_URL`) | Add that origin to `DSTNS_ALLOWED_ORIGINS` |

CORS still answers `Access-Control-Allow-Origin: *`, permitting cross-origin
reads at the application layer, subject to browser and network policy. Do not
assume a particular experiment's run state is non-sensitive. Restrict network
access and review data before sharing it; tighten deployment policy if run data
is confidential.

## Shutdown

`POST /api/v1/system/terminate` (and its alias `POST /terminate`) stops the
run and exits the process. There is no `GET` form: a GET can be triggered by an
`<img>` or a link, without CORS or the CSRF guard getting a say. The engine
kills an in-flight map download's whole process group, so nothing is left
running after the server exits.

## Request validation

Handlers validate by throwing, and the exception handler maps each exception
type to a status and code (see [API errors](../api/errors.md)). Specific rules:

| Input | Rule |
|---|---|
| Path IDs (`/edges/{id}`, `/signals/{id}`, `/nodes/{id}`) | Parsed as 32-bit unsigned; overflow is 400, never wrapped to another object |
| Times (`target_time`, `start_virtual_time`, SUMO `begin_s`/`end_s`) | Integer seconds in [0, 86400] or `HH:MM:SS` |
| Query numbers (`limit`, `offset`, `since_news_id`) | Unsigned decimal; a sign or garbage is 400 |
| Rates | Tick rate in (0, 5] |
| Edge overrides | Multipliers finite, in [0, 2] |
| Weather | Intensity and flood gain in [0, 1], radius > 0, duration in [1, 1440] minutes |
| Surges | Factor in (0, 10], radius in (0, 20000] m, duration in [1, 86400] s |
| Undo and redo `count` | Integer in [1, 10000], read signed so `-1` is refused rather than wrapped |
| Backpressure reports | Finite and non-negative |
| Seeds | Decimal, `0x` hex, `auto` or `random`; saved-seed IDs match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| Map configuration | City extent in [500, 20000] m, district nodes in [200, 50000], `max_nodes` in [2, 50000] |

## External processes

The server runs two kinds of external program:

- **The map downloader**, `python3 scripts/fetch_osm.py`, through
  `posix_spawn` of `/bin/sh -c`. Every argument is single-quoted, the child gets
  its own process group, and its pipe is close-on-exec.
- **SUMO** (`netconvert`, `sumo`) through `popen`. Every path, including the
  `directory` taken from the request body of `/export/sumo` and
  `/system/sumo-simulate`, is single-quoted, and exit statuses are checked.

The SUMO endpoints write their bundle wherever `directory` points, with the
server's permissions. They are operator tools; do not expose the API to
untrusted users while this holds.

## Untrusted text

OSM data comes from the network. `extract_attr` repairs mis-encoded UTF-8 and
caps attribute length before a value is stored, and `dump_json` refuses to emit
invalid UTF-8, so a corrupt map cannot break a response, a log line or a hash.
Downloader output reaches error messages only through `sanitize_message`.

## Logs

The system log flattens newlines in every message, so a request path with an
encoded `%0A` cannot forge entries. The SQLite journal uses prepared statements
throughout; the one dynamic table name (`rows()`) is checked against an
allow-list first.

## Containers and transport

- The container never mounts the Docker socket.
- The nginx gateway terminates TLS 1.2 and 1.3 on 8443, sets
  `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`, and forwards
  `X-Forwarded-Host` to the engine.
- `/api/v1/system/terminate` exits the process cleanly with no host
  privileges, so a container needs no extra capabilities.

## Hardening checklist

- [ ] Bind the server to `127.0.0.1` (`--host` for the standalone binary;
      `api.host` in `config/defaults.json` for the launcher) for local use.
- [ ] For remote access, add authentication or trusted network restrictions;
      keep the backend inaccessible directly and overwrite forwarded headers.
- [ ] Keep `logs/operator.token` readable only by the operator.
- [ ] Set `DSTNS_DISABLE_WORLD_REGENERATION=1` if observers should not be able
      to replace the world.
- [ ] Set `DSTNS_ALLOWED_ORIGINS` only to origins you serve the observer from.
- [ ] Use trusted certificates in `docker/certificates/` for anything beyond
      local development.

## Reporting a problem

Follow the repository's [security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md)
for supported versions, confidential reporting, report contents, triage and
coordinated disclosure. If a private report form or contact route is unavailable,
request a private contact without disclosing the affected endpoint or exploit.
Do not post vulnerability details in a public issue.

## Verifying the deployment boundary

```bash
./build/dstns_server --host 127.0.0.1 --port 8090
```

This starts a local-only standalone server; run it from the repository root after
building. It does not read the launcher's `api.host` setting. Use a dedicated
restricted logs directory on shared hosts and do not start a second process on a
port already in use.

For Compose, set `DSTNS_HOST_PORT=127.0.0.1:8090` to make the existing port mapping
local-only. Check `docker compose config` before deployment and verify reachability
from the intended client network. Enabling `--profile tls` adds port 8443; it does
not remove 8090 or authenticate the client.

Implementation references are `apps/dstns_server/main.cpp` (binding and token),
`src/api.cpp` (origin guard and credential-protected routes),
`docker-compose.yml` (published ports) and `docker/gateway/nginx.conf` (TLS and
forwarded headers). [Operations](operations.md) covers backup and recovery;
[Testing](../development/testing.md) describes the HTTP hardening suite.
