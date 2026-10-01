# Files and directories

Where DSTNS keeps its inputs and outputs, what is safe to delete, and what must
never be committed.

## Repository layout at run time

| Path | Created by | Contents | Safe to delete |
|---|---|---|---|
| `build/` | CMake | Compiled binaries and test executables | Yes; rebuilt on demand |
| `ui-engine/dist/` | `./launcher ui build` | The compiled observer the server serves | Yes; rebuilt on demand |
| `ui-engine/node_modules/`, `dstns-operator-cli/node_modules/` | `npm ci` | Node dependencies | Yes; reinstalled |
| `logs/` | the server | Logs, journal and credential (below) | Yes, with the server stopped; `./launcher reset` does it for you |
| `data/maps/` | the server | Cached city extracts and manifests | Yes; they are downloaded again when needed |
| `data/fixtures/` | repository | One recorded real district for offline use | No; tracked |
| `data/seed-store/` | `seeds.py` | The saved-seed SQLite database | Only if you do not need your saved seeds |
| `artifacts/` | tests, SUMO runs | Temporary scenarios and outputs | Yes |
| `site/` | `mkdocs build` | The built documentation | Yes |
| `.venv-docs/` | you | The documentation toolchain | Yes |

## The logs directory

`logs/` by default, `--logs DIR` on the server, `/app/logs` in the container.

| File | Format | Contents |
|---|---|---|
| `system.log` | text | One line per event: start-up, lifecycle transitions, map downloads, errors |
| `runtime.db`, `-wal`, `-shm` | SQLite, WAL mode | Journal of API requests, events and lifecycle changes |
| `global_view.json` | JSON | The full state of the run, rewritten every 10 seconds |
| `launcher.json` | JSON | The port and process the CLI last used, so it can reattach |
| `operator.token` | text, mode `0600` | The operator credential |

Details and queries are in [Logging and diagnostics](../deployment/logging.md).

!!! danger "Never commit `operator.token`"
    Anyone holding it can start runs on a server you operate. The repository's
    `.gitignore` excludes `logs/`; keep it that way.

## Map cache

Each cached city is two files in `data/maps/`:

| File | Contents |
|---|---|
| `<city>_x<extent>.osm.xml` | The OpenStreetMap extract, as returned by Overpass |
| `<city>_x<extent>.osm.manifest.json` | Provenance: source, licence (ODbL 1.0), endpoint, bounding box, retrieval time, byte count and SHA-256 |

The server sweeps the cache once at start-up according to `--map-cache` (see
[Command-line tools](command-line-tools.md#dstns_server)). Extracts are tens of
megabytes each.

!!! note "Map data licence"
    Extracts are OpenStreetMap data under the Open Database Licence. Keep the
    attribution "OpenStreetMap contributors" if you redistribute them.

## Configuration files

| File | Read by | Contents |
|---|---|---|
| `config/defaults.json` | CLI, server | Run, map, module and API defaults. See [Configuration](../guide/configuration.md) |
| `config/ui-config.json` | server, observer | The observer's starting state. See [Observer configuration](../guide/observer-configuration.md) |
| `docker-compose.yml`, `Dockerfile` | Docker | The container build and run definition |
| `mkdocs.yml`, `.readthedocs.yaml` | MkDocs, Read the Docs | This documentation site |

## What a saved seed contains

`./launcher start --save-seed ID` stores the seed, day type, duration, speed,
module switches and map choice in the SQLite database. For a pinned map it also
stores the source bytes, so the run can be reproduced even if the file later
changes. See [Seeds and places](../guide/seeds-and-places.md).
