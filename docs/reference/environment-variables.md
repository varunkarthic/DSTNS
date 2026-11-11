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
| `DSTNS_FETCHER` | the server | The program that downloads maps, run with `--fetch-osm` and the options below. Normally the server runs itself |
| `DSTNS_NARRATOR` | `auto` | Narration backend, as `--narrator`: `auto`, `fm`, `off`, `http://HOST:PORT` or `unix:/PATH`. See [Realistic News](../guide/narration.md) |
| `DSTNS_NARRATOR_MODEL` | `system` | Model name for a Chat Completions endpoint, as `--narrator-model` |
| `DSTNS_NARRATOR_CACHE` | `<logs>/narrations.db` | Persistent narration cache, as `--narrator-cache`; `none` for memory only |
| `DSTNS_OVERPASS_ENDPOINTS` | built-in list | Comma-separated Overpass API endpoints the downloader tries in order |
| `SUMO_HOME` | unset | Root of an Eclipse SUMO installation; needed only for the SUMO adapter. The image sets `/usr/share/sumo` |

See [Deployment security](../deployment/security.md) for when to use the first
three.

## Operator CLI

Read by `./launcher`, the Rust launcher in `LaunchKit/`.

| Variable | Default | Meaning |
|---|---|---|
| `DSTNS_API_PORT` | Last healthy port in `logs/launcher.json`, then `api.port` from `config/defaults.json` | Port to start on or attach to. An invalid value stops the CLI with `Invalid DSTNS_API_PORT` |
| `DSTNS_LOGS_DIR` | `logs/` in the repository | Logs directory passed to the server and read for the credential |
| `DSTNS_OPERATOR_TOKEN` | contents of `logs/operator.token` | Credential sent in the `X-DSTNS-Operator` header |
| `DSTNS_GROQ_API_KEY` | unset | The Groq key for the launcher's model, kept in `config/launcher.env` by `./launcher model key KEY`. `GROQ_API_KEY` works too |
| `DSTNS_LAUNCHER_ENV` | `config/launcher.env` | Where the launcher keeps its own state and the variables `env set` keeps |
| `DSTNS_VERIFIED_BY` | set by the launcher | Under [Advanced Security](../guide/operator-cli.md#advanced-security), the process id of the launcher that verified, passed to what it starts. Honoured only when that process is the launcher itself, so setting it by hand does nothing |
| `DSTNS_SEED_DB` | `data/seed-store/seeds.sqlite3` | SQLite file holding saved seeds |
| `DSTNS_BUILD_DIR` | `build/`, or the local cache in a cloud-synced checkout | Where the launcher configures and compiles the core |
| `DSTNS_UI_DIST` | unset | Read by the server: the observer bundle to serve, before the usual `WebKit/dist` search. The launcher sets it for a synced checkout |
| `DSTNS_ROOT` | set by `./launcher` | The checkout. Without it, the launcher looks above its own program and the working directory for `CMakeLists.txt` and `config/defaults.json` |
| `DSTNS_SETUP_COMPLETE` | from `config/launcher.env` | `1`: the first-launch setup has been done. Unset, the terminal interface walks through it first. A value in the shell wins over the file |
| `DSTNS_LAUNCHER_ENV` | `config/launcher.env` | The file the launcher keeps its own state in |
| `DSTNS_APPS_FILE` | `config/apps.json` | The application catalogue |
| `CARGO_TARGET_DIR` | `LaunchKit/target/`, or the local cache in a cloud-synced checkout | Where `./launcher` builds the launcher |
| `NO_COLOR` | unset | Any nonempty value disables colour |
| `TERM` | terminal-provided | `dumb` selects plain output |

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
| `DSTNS_SPEED` | `1` | Initial speed multiplier, in (0, 10] |
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
| `DSTNS_IMAGE` | `ghcr.io/varunkarthic/dstns:stable` | Published image tag or digest |
| `DSTNS_WITH_SUMO` | `0` | With `docker-compose.build.yml`: `1` includes SUMO |
| `DSTNS_REVISION` | `unknown` | Local build override: source revision |
| `DSTNS_BUILD_DATE` | `unknown` | Local build override: UTC build timestamp |

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

## Fabric and presentation

Read by the server when it starts. The launcher sets them from its settings; see
[What the operator can turn off](../api/security.md#what-the-operator-can-turn-off).

| Variable | Default | Meaning |
|---|---|---|
| `DSTNS_FABRIC_APPS` | `1` | `0` stops applications from registering |
| `DSTNS_LEGACY_API` | `1` | `0` turns the older `/playback` and `/control` routes off |
| `DSTNS_LAUNCH_PROPOSALS` | `1` | `0` stops applications proposing how to start them |
| `DSTNS_REQUIRE_SIGNATURES` | `0` | `1` makes every application sign its requests |
| `DSTNS_DISABLED_CAPABILITIES` | empty | Comma-separated capabilities nobody may be granted |
| `DSTNS_MUSIC_FILE` | unset | An MP3, M4A or WAV file the film plays instead of the written score, served at `GET /api/v1/system/music`; the launcher sets it from `presentation.music_file` or `demo.music_file` |
| `DSTNS_PRESENTATION` | `{}` | JSON for the observer: `webfabric`, `force_animate`, `fast_boot`, `dynamic_fastboot`, `dynamic_particles`, `demo`, `music`, `fullscreen` (true or false), `music_volume` (0 to 1), `map_fps` (0, 30 or 60), `render_scale` (0.5 to 3), `film_particles` (4,000 to 32,000) and `demo_scenes` (scene ids, in order). Anything else is ignored. `force_animate` is reported off whenever `fast_boot` or `dynamic_particles` is on |
| `DSTNS_DYNAMIC_FASTBOOT` | `1` | `0` stops the server choosing the next world and fetching its city while a world runs; see [Dynamic Fastboot](../guide/fast-boot.md#dynamic-fastboot) |
| `DSTNS_DAEMON` | `{}` | JSON for the [daemons](../guide/daemons.md), laid over their defaults: `enabled`, `sustain_s`, `daemons` (each on or off), `rcs.modules.MODULE.memory_mib` and `.cpu_percent` (α, β, γ), and `cache.interval_s`, `max_mib`, `stale_part_s`. The launcher writes it from its settings |
| `DSTNS_MAPS_DIR` | the server's `--maps` | Set by the server for its daemons: the map cache the disk watch and the cache handler look after |
| `DSTNS_COMPRESSION` | `fast` | How hard snapshots and the topology, the large responses, are compressed: `fast`, `balanced`, `small`, `off`, or a zlib level 0 to 9 |
| `DSTNS_API_THREADS` | the library's choice | How many requests are answered at once |
| `DSTNS_ENGINE_THREADS` | half the cores, up to 8 | Threads that write a large snapshot; 1 keeps it to one |
| `DSTNS_FABRIC_LAUNCH_KEY` | | Given by the launcher to an application it starts, to present when it registers |
| `DSTNS_FASTBOOT_DIR` | | A folder of `{key}.osm.xml.gz` files, from `./launcher fastboot download`. A city found there is unpacked rather than downloaded |

## Standard variables

Not DSTNS's own, but respected by the launcher.

| Variable | Default | Meaning |
|---|---|---|
| `XDG_CACHE_HOME` | `~/.cache` | Where the launcher's environment and a build outside a synced folder are kept |
| `XDG_STATE_HOME` | `~/.local/state` | Where the launcher keeps state for a checkout in a synced folder |
| `COLORTERM`, `WT_SESSION` | | How much colour the terminal can show |
| `DISPLAY`, `WAYLAND_DISPLAY` | | Whether there's a browser to open |
