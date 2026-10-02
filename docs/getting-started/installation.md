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
| Node.js | 20 | Building the observer |
| npm | 9 | Installing JavaScript dependencies |
| Python 3 | 3.10 | The launcher, the map downloader and the test suites |
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

1. installs its terminal interface on first interactive use (into `.venv-launcher/`);
2. shows the SVG-derived wordmark for at least three seconds while running the
   [start-up checks](#start-up-checks), then opens the dashboard;
3. after **Start simulation** is selected, configures and compiles the core, and installs and builds the observer,
   only when their sources have changed since the last build;
4. starts `build/dstns_server`, opens the observer and starts a run.

Use `./launcher start` to proceed directly to a run. Build and download time
depend on hardware, network and cache state; the first build can take a few
minutes. Activity labels name the current operation throughout preparation.
See [Loading feedback](../guide/operator-cli.md#loading-feedback) for animation
and static-output options.

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

```

`scripts/build.sh` runs the first two steps. The outputs:

| Output | What it is |
|---|---|
| `build/dstns_server` | The server: engine, API and observer host |
| `build/dstns_scenario_export` | Compile a synthetic-grid scenario and export it as SUMO files |
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

Opened in a terminal, the launcher checks that this machine can run a simulation
before showing the dashboard, and says what to do when it cannot: the platform,
Python, the build tools, both configuration files, the logs directory, the map
downloader and cache, the core and observer builds, the API port and SUMO. Every check
is listed in [Launcher: environment check](../guide/operator-cli.md#environment-check).
**Diagnostics** in the launcher can also run the core, HTTP, loading and observer
test suites on this machine.

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
./launcher start    # rebuilds whatever changed and starts a run
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
| `ui-engine/dist/`, `ui-engine/node_modules/` | JavaScript build and dependencies | Yes |
| `.venv-launcher/` | The launcher's terminal interface | Yes; reinstalled on next use |
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

??? failure "`No rule to make target '/opt/homebrew/Cellar/…'`"
    Homebrew upgraded a library (SQLite or zlib, for example) after the build was
    configured, and the CMake cache still names the old path. Run the
    `cmake --fresh` command under [Updating](#updating).

??? failure "`npm: command not found` while building the observer"
    Install Node.js 20 or later and make sure `node` and `npm` are on `PATH`. Node.js
    is needed only to build the observer.

??? failure "The launcher opens in compatibility mode"
    The terminal interface could not be installed or started; the reason is in
    `logs/launcher.log`. See [Troubleshooting: the launcher](../troubleshooting.md#the-launcher).

??? failure "The FetchContent step hangs or fails"
    The first configure downloads two libraries from GitHub. Behind a proxy,
    set `HTTPS_PROXY`; offline, configure once on a connected machine and copy
    `build/_deps/`.

More in [Troubleshooting](../troubleshooting.md).
