# Installation

Build and run DSTNS from source. If you only want to run it, [Docker](docker.md)
is quicker: it needs nothing but Docker.

## Supported platforms

| Platform | Status | Notes |
|---|---|---|
| macOS 13 or later, Apple silicon or Intel | Supported | Primary development platform |
| Ubuntu 22.04 / 24.04, Debian 12 | Supported | Built in CI and in the container image |
| Fedora 39+, Arch | Expected to work | Same dependencies under other package names |
| Windows 10/11 | Through WSL 2 | The core uses POSIX process APIs (`posix_spawn`, `popen`), so native Windows builds are not supported |

## Prerequisites

| Tool | Minimum | Used for |
|---|---|---|
| C++ compiler | GCC 12, Clang 15 or Apple Clang 15 (C++20) | The simulation core |
| CMake | 3.22 | Building the core and its tests |
| SQLite 3 (development headers) | any current | The runtime journal |
| zlib (development headers) | any current | Compressing large API responses |
| Node.js | 20 | The operator CLI and the observer build |
| npm | 9 | Installing JavaScript dependencies |
| Python 3 | 3.10 | The map downloader and the test suites |
| git | any | Cloning; CMake also fetches two header-only libraries |
| Eclipse SUMO | optional, 1.15+ | The microscopic cross-check |

CMake downloads [nlohmann/json](https://github.com/nlohmann/json) 3.12.0 and
[cpp-httplib](https://github.com/yhirose/cpp-httplib) 0.28.0 on the first
configure, so that step needs network access.

### Installing the prerequisites

=== "macOS"

    ```bash
    xcode-select --install                  # Apple Clang, make, git
    brew install cmake node python          # SQLite and zlib ship with macOS
    brew install sumo                       # optional
    ```

=== "Ubuntu / Debian"

    ```bash
    sudo apt-get update
    sudo apt-get install -y build-essential cmake git python3 \
        libsqlite3-dev zlib1g-dev ca-certificates curl
    # Node.js 20+ (the distribution package is often older):
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    sudo apt-get install -y sumo sumo-tools  # optional
    ```

=== "Fedora"

    ```bash
    sudo dnf install -y gcc-c++ cmake git python3 sqlite-devel zlib-devel nodejs npm
    sudo dnf install -y sumo                 # optional
    ```

=== "Windows (WSL 2)"

    ```powershell
    wsl --install -d Ubuntu-24.04
    ```

    Then open the Ubuntu shell and follow the Ubuntu tab. Clone the
    repository inside the Linux file system (`~/`), not under `/mnt/c`:
    builds there are many times slower. Open the observer from Windows at
    `http://localhost:8090`.

Check the toolchain:

```bash
c++ --version && cmake --version && node --version && python3 --version
```

## Get the code

```bash
git clone https://github.com/varunkarthic/DSTNS.git
cd DSTNS
```

## Build and run with the launcher

```bash
./launcher
```

The launcher is the supported path. It:

1. installs the operator CLI's npm dependencies on first use;
2. runs the [start-up checks](#start-up-checks);
3. configures and compiles the core, and installs and builds the observer,
   only when their sources have changed since the last build;
4. starts `build/dstns_server`, opens the observer and starts a run.

The first build takes a few minutes. Later starts take seconds.

## Build manually

Everything the launcher does can be done by hand, which is useful when
developing:

```bash
# The core and its tests
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j

# The observer
npm ci --prefix ui-engine
npm run build --prefix ui-engine

# The CLI's dependencies
npm ci --prefix dstns-operator-cli
```

`scripts/build.sh` runs the first two steps. The outputs:

| Output | What it is |
|---|---|
| `build/dstns_server` | The server: engine, API and observer host |
| `build/dstns_scenario_export` | Compile a scenario and export it as SUMO files |
| `build/dstns_replay_verify` | Check that a seed reproduces exactly |
| `build/dstns_road_index` | Inspect a map's road graph |
| `build/dstns_benchmark` | Routing and snapshot benchmarks |
| `build/dstns_*_tests` | The native test suites |
| `ui-engine/dist/` | The observer bundle the server serves |

Run the server on its own and start a run from another terminal:

```bash
./build/dstns_server --port 8090 --logs logs
./launcher start --seed 382923          # attaches to the running server
```

## Start-up checks

Every `./launcher start` verifies that this machine can actually run a
simulation before it starts one, and says what to do when it cannot:

| Check | Fails when |
|---|---|
| Host platform | Not macOS or Linux (warning) |
| Node runtime, Python 3 | Missing or too old |
| Runtime configuration, interface configuration | `config/defaults.json` or `config/ui-config.json` is invalid |
| Interface bundle, observer bundle, simulation core | A build output is missing or stale |
| Map fetcher, map cache | `scripts/fetch_osm.py` is missing, or the cache directory is not writable |
| API port | The port is taken by something that is not DSTNS |
| Core, API contract, loading and observer test suites | A fast test suite fails on this machine |

## Optional: SUMO

SUMO is only needed for the [SUMO adapter](../components/sumo-adapter.md). DSTNS
finds `sumo` and `netconvert` through `SUMO_HOME`, the standard prefixes or
`PATH`, and uses them only if both start:

```bash
export SUMO_HOME=/opt/homebrew/share/sumo    # or wherever SUMO is installed
curl -s localhost:8090/api/v1/system/info | python3 -m json.tool | grep -A3 '"sumo"'
```

!!! warning "A SUMO that cannot start"
    On macOS, a Homebrew upgrade can replace a library a locally built SUMO
    links against (`abseil`, `re2`). SUMO then fails with
    `dyld: Library not loaded` and DSTNS reports it unavailable. Rebuild or
    reinstall SUMO. See [Troubleshooting](../troubleshooting.md#sumo-reported-unavailable).

## Verify the installation

```bash
ctest --test-dir build --output-on-failure      # 14 native and HTTP suites
npm test --prefix ui-engine                     # observer suites
```

Both should pass in under a minute. See [Testing](../development/testing.md)
for everything else.

## Updating

```bash
git pull
./launcher          # rebuilds whatever changed
```

If a build fails after an update, or after a system library upgrade, start the
CMake cache afresh:

```bash
cmake --fresh -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
```

## Uninstalling

Everything DSTNS creates lives inside the repository:

| Path | Contents | Safe to delete |
|---|---|---|
| `build/` | Native build | Yes; rebuilt on next start |
| `ui-engine/dist/`, `ui-engine/node_modules/`, `dstns-operator-cli/node_modules/` | JavaScript build and dependencies | Yes |
| `logs/` | Logs, journal, operator token | Yes; `./launcher reset` clears it |
| `data/maps/` | Downloaded city maps | Yes; downloaded again when needed |
| `data/seed-store/` | Saved seeds | Only if you no longer need them |

Delete the repository directory to remove DSTNS completely.

## Troubleshooting installation

??? failure "`CMake 3.22 or higher is required`"
    Your distribution's CMake is too old. On Ubuntu 20.04, install a newer one
    with `pip install cmake` or from [Kitware's APT repository](https://apt.kitware.com/).

??? failure "`Could NOT find SQLite3`"
    Install the development package: `libsqlite3-dev` (Debian, Ubuntu) or
    `sqlite-devel` (Fedora).

??? failure "`No rule to make target '/opt/homebrew/Cellar/openssl@3/…/libssl.dylib'`"
    Homebrew upgraded a library after the build was configured, and the CMake
    cache still names the old path. Run the `cmake --fresh` command under
    [Updating](#updating).

??? failure "`Error: Node.js (>= 20) is required`"
    Install Node.js 20 or later and make sure `node` is on `PATH`.

??? failure "The FetchContent step hangs or fails"
    The first configure downloads two libraries from GitHub. Behind a proxy,
    set `HTTPS_PROXY`; offline, configure once on a connected machine and copy
    `build/_deps/`.

More in [Troubleshooting](../troubleshooting.md).
