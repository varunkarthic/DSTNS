# DSTNS operator CLI

The Node console lives in `dstns-operator-cli/`; the repository root is its parent. Install with `npm ci --prefix dstns-operator-cli`, then use `./launcher start` or `node dstns-operator-cli/dstns.mjs start` from the repository root.

## Placement

Copy this folder into the DSTNS repository root as:

```text
DSTNS/
├── dstns-operator-cli/
│   ├── dstns.mjs
│   └── package.json
├── build/
├── config/
├── ui-engine/
└── ...
```

The CLI resolves the DSTNS project root as the parent directory of `dstns-operator-cli`.

## Install

```bash
cd dstns-operator-cli
npm ci
```

## Run

From the repository root, `./launcher` (or `python3 launcher.py`) checks that the CLI dependencies load and installs them if needed. Direct Node execution requires the install step above.

```bash
npm start
```

Or make the launcher executable and invoke it directly:

```bash
chmod +x dstns.mjs
./dstns.mjs
```

## Useful commands

```bash
./dstns.mjs start
./dstns.mjs logs system
./dstns.mjs logs api
./dstns.mjs config
./dstns.mjs test all
./dstns.mjs test unit
./dstns.mjs test ui
./dstns.mjs test all --verbose
./dstns.mjs sumo
./dstns.mjs reset
./dstns.mjs reset --yes
./dstns.mjs --mode=server
```

The C++ process remains the simulation authority. The Node launcher is only the operator/presentation layer.

## Non-interactive launcher arguments

```bash
./launcher start --seed 382923 --day-type weekend --save-seed campus-test
./launcher start --saved-seed campus-test
./launcher seeds list
./launcher seeds inspect campus-test
./launcher seeds delete campus-test
./launcher logs system
./launcher test all
./launcher sumo
```

`start` starts playback immediately. Weekday is the default. The browser observes the core and exposes pause/resume/speed. See the [modernization guide](https://dstns.readthedocs.io/en/latest/history/modernization/) for validated arguments, pinned OSM source storage, private operator credentials and process ownership. Interactive terminal menus remain available by running `./launcher` without arguments.


## Reproducible local workflow

Run from the repository root after installing the [source prerequisites](https://dstns.readthedocs.io/en/latest/getting-started/installation/):

```bash
./launcher start --seed 382923 --day-type weekday \
  --osm-file data/fixtures/real_network.osm.xml --no-open
```

The launcher validates configuration, builds stale components, supervises the native
server and submits a start request with the local operator credential. The pinned
map avoids a network download, and `--no-open` suppresses opening a browser. The
engine remains the authority for the clock and simulation state.

Check the actual server URL reported by the launcher; it may select another port
when the configured port is occupied. Then inspect readiness:

```bash
curl --fail --silent --show-error http://127.0.0.1:8090/api/v1/playback/status
```

`PREPARING` means a request was accepted and compilation is underway. `RUNNING`
means playback has started. An `IDLE` state with `preparation_error` indicates a
failed preparation. Do not infer successful startup from an open browser alone.

## Credentials and destructive commands

The launcher uses `<logs>/operator.token`; `DSTNS_LOGS_DIR` selects a different
logs directory. Keep this file private and out of shared logs or Git commits.
Configure `api.host` in `config/defaults.json` as `127.0.0.1` for local-only access.
The token protects start and prepare; other controls still require network access
restrictions. See the [security policy](../SECURITY.md).

The reset commands listed above remove runtime state; `--yes` skips their
confirmation. Preserve required maps, saved seeds and diagnostics before using
reset. Deleting a saved seed removes that stored configuration. Refer to
[Operator CLI](https://dstns.readthedocs.io/en/latest/guide/operator-cli/) for exact command behavior and
[Operations](https://dstns.readthedocs.io/en/latest/deployment/operations/) for backup and recovery.

## Development checks

```bash
npm ci --prefix dstns-operator-cli
node --test tests/cli/*.test.mjs
python3 tests/cli/test_seeds.py
python3 tests/cli/test_fetch_osm.py
```

These repository-root commands install the committed dependency graph and test
artifact rebuild detection, saved-seed persistence and map fetching. They do not
replace live launcher integration or the native server suites. See
[Testing](https://dstns.readthedocs.io/en/latest/development/testing/) for the broader gates.
