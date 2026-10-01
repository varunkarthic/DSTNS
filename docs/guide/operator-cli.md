# Operator CLI

`dstns-operator-cli/dstns.mjs` is how an operator builds DSTNS, starts and
supervises a run, inspects logs, edits defaults, manages saved seeds and runs
the tests. It is the only supported way to start a simulation: the server
refuses start requests that lack the credential the CLI holds. This page covers
every command and what happens, step by step, when a run starts.


## Entry points

```bash
./launcher [command] [flags]          # shell wrapper
python3 launcher.py [command] [flags] # Python wrapper (also reattaches to a running core)
node dstns-operator-cli/dstns.mjs ... # direct, after npm ci --prefix dstns-operator-cli
```

Node 20 or later is required. The wrappers install the CLI's dependencies on
first use.

## Commands

| Command | Does |
|---|---|
| `start` (default) | Build what has changed, start or reuse the server, open the observer, start a run. Flags below |
| `seeds save\|list\|inspect\|delete [ID]` | Manage saved seeds; see [Saved seeds](saved-seeds.md) |
| `ui open\|dev\|build\|install` | Open the observer, run the Vite dev server, build the bundle, or install its dependencies |
| `logs [topic]` | Inspect the system log, API log, event log or lifecycle log |
| `config` | Validate and edit `config/defaults.json` interactively: speed, duration, host, port, modules |
| `test [scope]` | Run test stages: `all`, `unit`, `api`, `replay`, `benchmark`, `sumo` or `ui` |
| `sumo` | Check the SUMO toolchain on a synthetic grid, outside the server |
| `reset` | Delete runtime logs, the SQLite journal, checkpoints, temporary scenarios and SUMO runs, after confirmation |
| `console` | The interactive dashboard |
| `help` | Command summary |
| `--mode=server` | Run `dstns_server` in the foreground with the configured host and port |
| `--version`, `--licence` | Version and licence |

### `start` flags

| Flag | Range | Meaning |
|---|---|---|
| `--seed N` | decimal or `0x` hex, up to 128 bits | The seed. Omitted: a fresh 64-bit seed |
| `--saved-seed ID` | | Run a saved configuration; excludes `--seed` |
| `--save-seed ID` | | Save this run's configuration under `ID` |
| `--description TEXT` | | Note stored with `--save-seed` |
| `--day-type weekday\|weekend` | | Day type |
| `--duration S` | integer 60 to 3600 | Wall-clock seconds per virtual day at 1× |
| `--speed X` | 0.01 to 5 | Initial speed multiplier |
| `--max-nodes N` | integer 2 to 50000 | Graph size cap |
| `--osm-file PATH` | existing file | Pin a map instead of letting the seed choose |
| `--no-open` | | Do not open a browser |
| `--yes` | | Skip confirmations (for `reset`) |
| `--verbose` | | Full task output |

## Starting a run

1. **Validate configuration.** `config/defaults.json` and any flags are checked
   against the same bounds the engine enforces, and a run payload is assembled
   (see [Configuration](configuration.md#precedence)).
2. **Build what changed.** The CLI fingerprints `CMakeLists.txt`, `src/`,
   `include/` and `apps/dstns_server`, and separately the observer sources and
   lockfile. It reconfigures and recompiles the core, runs `npm ci`, and builds
   the observer bundle only when a fingerprint differs from the one stored
   beside the last build (`.launcher-source`).
3. **Find a server.** If the port in `api.port` (or `DSTNS_API_PORT`, or the
   last port recorded in `logs/launcher.json`) answers `/health` as a current
   DSTNS server, the CLI attaches to it. If the port is held by something else,
   or by an older DSTNS, it picks the next free port. Otherwise it spawns
   `dstns_server --host H --port P --logs L` and waits up to 15 s for health.
4. **Open the observer** at `http://127.0.0.1:<port>/` and wait for
   `/api/v1/system/observer` to report it has loaded, so world selection, the
   download and generation are watched in the interface rather than behind a
   blank tab.
5. **Start the run.** `POST /api/v1/playback/start` with the payload and the
   `X-DSTNS-Operator` credential from `logs/operator.token`. For a
   seed-selected map, the CLI follows the download with a progress bar from
   `/api/v1/system/map-status`.
6. **Confirm the world.** The CLI reads the topology, checks that a real
   OpenStreetMap network loaded, and reports the city, the anchor coordinates,
   whether the map was downloaded or cached, and the node and place counts.

If a run is already `RUNNING` or `PAUSED` on the server and no run flags were
given, the CLI attaches to it and opens the observer instead of starting
another.

## Seeds and saved seeds

A seed is a plain number, and it names a run from end to end: what you type is
what the interface shows and what reproduces the world. With `map.osm_file:
auto`, the seed chooses one of 181 cities and a district anchor inside it; the
city's extract is downloaded once and cached under `data/maps/`. See
[Deterministic seeding](../concepts/deterministic-seeding.md) and [OSM map
generation](../concepts/osm-map-generation.md).

`--save-seed ID` stores the full resolved configuration under a name, and
`--saved-seed ID` starts it again. For a pinned map the store also keeps a copy of
the file, verified by SHA-256 on every replay. IDs match
`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. See [Saved seeds](saved-seeds.md).

## The interactive console

`./launcher console` opens a full-screen menu:

| Key | Action |
|---|---|
| `↑` `↓` or `k` `j` | Move |
| `Space` | Mark the highlighted option |
| `Enter` | Run the marked option |
| `Esc` or `q` | Back, or exit |

The menu offers session control (start, pause, resume, status, logs,
terminate), configuration, tests, SUMO and reset, with live telemetry from the
running server shown above it.

## Tests from the CLI

`./launcher test` runs each stage as a task and prints a summary table with
durations; the exit code is non-zero if any stage fails. Scopes:

| Scope | Runs |
|---|---|
| `unit` | CTest: unit, property, replay and performance suites |
| `api` | The HTTP contract suite against a fresh server |
| `replay` | Reproducibility verification |
| `benchmark` | The performance tool |
| `sumo` | The SUMO integration smoke test |
| `ui` | The observer's Vitest suites |
| `all` | Configure and build, then everything above, then the production observer bundle |

## Logs

`./launcher logs` reads the server's text log (`logs/system.log`) and the
tables of the SQLite journal (`logs/runtime.db`): `api_log` (every request),
`event_log` (operator commands) and `lifecycle_log` (every state transition).
The same data is available over HTTP at `/api/v1/view/logs/{system,events,api}`.
See [Logging](../deployment/logging.md).

## Reset

`./launcher reset` (or `scripts/reset.sh`) deletes `system.log`, `runtime.db`
and its WAL files, `data/checkpoints/`, `data/scenarios/` and
`data/sumo_live_run/`. The OSM cache, saved seeds and configuration are kept.

## Standalone SUMO

`./launcher sumo` checks that the SUMO toolchain works end to end, without a server.
It requires `sumo` and `netconvert` (under `SUMO_HOME` or on `PATH`), exports a
deterministic 12 × 12 synthetic grid with `dstns_scenario_export` into
`data/sumo_live_run/`, builds the network with `netconvert`, runs SUMO and summarises
the trip statistics. It never touches a live run.

To run SUMO on the city you are watching, use the API instead:
`POST /api/v1/system/sumo-simulate` (see [SUMO adapter](../components/sumo-adapter.md)).

## Ending a session

When the CLI started the server itself, it ends the session when the server
exits, and stops the server when you press Ctrl-C. When it attached to a server
that was already running, it watches that server and exits when it stops.
Terminating from the observer (`POST /api/v1/system/terminate`) shuts the
server down, which ends the CLI session too.

## Failure messages

| Message | Meaning and remedy |
|---|---|
| `playback.tick_rate must be in (0, 5]` | `config/defaults.json` asks for a speed the engine refuses |
| `Seed must be a decimal integer or 0x hexadecimal, within 128 bits` | Malformed `--seed` |
| `--seed and --saved-seed are mutually exclusive` | Pick one |
| `OSM data unavailable; provide --osm-file PATH` | A pinned map path does not exist |
| `MAP_FETCH_FAILED …` | The seed's district could not be downloaded. The CLI lists maps already on disk and the command to run one offline. Check the network, or set `DSTNS_OVERPASS_ENDPOINTS` |
| `Server did not become healthy within 15s` | See [Troubleshooting](../troubleshooting.md) |
| `The server did not load a usable real OSM network.` | The run started but the topology is empty or synthetic |
