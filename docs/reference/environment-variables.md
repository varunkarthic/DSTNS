# Environment variables

Every environment variable DSTNS reads, grouped by what reads it. Defaults are the
values used when the variable is unset or empty.

## Server

Read by `dstns_server` and the API it hosts.

| Variable | Default | Meaning |
|---|---|---|
| `DSTNS_OPERATOR_TOKEN` | generated | The operator credential. When unset the server generates one and writes it to `<logs>/operator.token`. When set, the server uses it and still writes the file. Needed by `start` and `prepare` |
| `DSTNS_ALLOWED_HOSTS` | empty | Comma-separated extra `Host` names accepted when the server is bound to loopback. Anything else gets HTTP 421 `HOST_NOT_ALLOWED`. Guards against DNS rebinding |
| `DSTNS_ALLOWED_ORIGINS` | empty | Comma-separated origins allowed to make state-changing requests besides the server's own. Anything else gets 403 `CROSS_ORIGIN_FORBIDDEN` |
| `DSTNS_DISABLE_WORLD_REGENERATION` | unset | `1` makes `POST /api/v1/world/regenerate` return 403, so viewers cannot replace the world |
| `DSTNS_PYTHON` | `python3` | Interpreter used to run the map downloader |
| `DSTNS_OVERPASS_ENDPOINTS` | built-in list | Comma-separated Overpass API endpoints the downloader tries in order |
| `SUMO_HOME` | unset | Root of an Eclipse SUMO installation; needed only for the SUMO adapter. The image sets `/usr/share/sumo` |

See [Deployment security](../deployment/security.md) for when to use the first
three.

## Operator CLI

Read by `./launcher` and `python3 launcher.py` (the Python launcher), and the
scripts they run.

| Variable | Default | Meaning |
|---|---|---|
| `DSTNS_API_PORT` | Last healthy port in `logs/launcher.json`, then `api.port` from `config/defaults.json` | Port to start on or attach to. An invalid value stops the CLI with `Invalid DSTNS_API_PORT` |
| `DSTNS_LOGS_DIR` | `logs/` in the repository | Logs directory passed to the server and read for the credential |
| `DSTNS_OPERATOR_TOKEN` | contents of `logs/operator.token` | Credential sent in the `X-DSTNS-Operator` header |
| `DSTNS_SEED_DB` | `data/seed-store/seeds.sqlite3` | SQLite file holding saved seeds |
| `DSTNS_LAUNCHER_NO_INSTALL` | unset | `1` prevents automatic installation of the optional terminal interface; compatibility mode remains available |
| `NO_COLOR` | unset | Any nonempty value disables colour |
| `TERM` | terminal-provided | `dumb` selects plain output and skips interface installation |

## Observer build

| Variable | Default | Meaning |
|---|---|---|
| `VITE_DSTNS_API_URL` | same origin | API base URL when the observer is served from somewhere else. That origin must then be listed in `DSTNS_ALLOWED_ORIGINS` |
| `DSTNS_API_PORT` | 8090 | Port the Vite dev server proxies `/api` to |

## Container

Read by the container entrypoint and `dstns-run`. The image sets the defaults
shown; Compose passes the same names through. See [Run with Docker](../getting-started/docker.md)
and [Docker deployment](../deployment/docker.md).

| Variable | Default | Meaning |
|---|---|---|
| `DSTNS_PORT` | `8090` | Port the server listens on inside the container |
| `DSTNS_AUTOSTART` | `1` | `0` starts the server without starting a run |
| `DSTNS_SEED` | `auto` | Decimal or `0x` seed; `auto` draws a fresh one |
| `DSTNS_DAY_TYPE` | `weekday` | `weekday` or `weekend` |
| `DSTNS_SPEED` | `1` | Initial speed multiplier, in (0, 5] |
| `DSTNS_DURATION` | `3600` | Wall-clock seconds per virtual day at 1x, 60 to 3600 |
| `DSTNS_OSM_FILE` | `auto` | `auto` lets the seed choose the map; a path inside the container pins one |
| `DSTNS_MAP_CACHE` | `prune` | `keep`, `prune` or `clear`; passed to `--map-cache` |
| `DSTNS_MAP_CACHE_KEEP` | `3` | Extracts `prune` keeps; passed to `--map-cache-keep` |

## Docker Compose only

Read by `docker-compose.yml` when it builds the command and the port mappings.

| Variable | Default | Meaning |
|---|---|---|
| `DSTNS_BIND` | `127.0.0.1` | Host address the ports are published on. `0.0.0.0` exposes the API to the network |
| `DSTNS_HOST_PORT` | `8090` | Host port mapped to the API |
| `DSTNS_TLS_PORT` | `8443` | Host port of the TLS gateway (the `tls` profile) |
| `DSTNS_WITH_SUMO` | `0` | Build argument: `1` installs SUMO into the image |

## Setting them

```bash
# One command
DSTNS_SEED=382923 DSTNS_DAY_TYPE=weekend docker compose up

# A .env file next to docker-compose.yml, read by Compose
printf 'DSTNS_SEED=382923\nDSTNS_SPEED=2\n' > .env

# A shell session for the CLI
export DSTNS_API_PORT=9000
./launcher start --seed 382923
```

!!! note "Secrets"
    `DSTNS_OPERATOR_TOKEN` is a credential. Keep it out of shell history, images
    and repositories; prefer the generated file in the logs directory.
