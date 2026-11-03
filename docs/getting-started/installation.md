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
| Rust and Cargo | 1.89 | The launcher, built by `./launcher` on first use ([rustup.rs](https://rustup.rs)) |
| libcurl (development headers) | any current; the system's on macOS | The map downloader, which is the server itself |
| git | any | Cloning; CMake also fetches two header-only libraries |
| Eclipse SUMO | optional, 1.15+ | The microscopic cross-check |

CMake downloads [nlohmann/json](https://github.com/nlohmann/json) 3.12.0 and
[cpp-httplib](https://github.com/yhirose/cpp-httplib) 0.28.0 on the first
configure, so that step needs network access.

### Installing the prerequisites

=== "macOS"

    ```bash
    xcode-select --install                  # Apple Clang, make, git
    brew install cmake node                 # SQLite, zlib and libcurl ship with macOS
    curl https://sh.rustup.rs -sSf | sh     # Rust, for the launcher
    brew install sumo                       # optional
    ```

=== "Ubuntu / Debian"

    ```bash
    sudo apt-get update
    sudo apt-get install -y build-essential cmake git \
        libsqlite3-dev zlib1g-dev libcurl4-openssl-dev ca-certificates curl
    curl https://sh.rustup.rs -sSf | sh     # Rust, for the launcher
    # Node.js 20+ (the distribution package is often older):
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    sudo apt-get install -y sumo sumo-tools  # optional
    ```

=== "Fedora"

    ```bash
    sudo dnf install -y gcc-c++ cmake git sqlite-devel zlib-devel libcurl-devel nodejs npm cargo
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
c++ --version && cmake --version && node --version && cargo --version
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

1. builds itself with Cargo the first time (about a minute), and again only when its sources change;
2. assembles the wordmark out of particles while running the
   [start-up checks](#start-up-checks), and on a first launch walks through the
   [setup](../guide/operator-cli.md#first-launch-the-setup) before the dashboard;
3. after **Start simulation** is selected, configures and compiles the core, and installs and builds the observer,
   only when their sources have changed since the last build;
4. starts `build/dstns_server`, opens the observer and starts a run.

Use `./launcher start` to proceed directly to a run. Build and download time
depend on hardware, network and cache state; the first build can take a few
minutes. Activity labels name the current operation throughout preparation.
See [Start-up](../guide/operator-cli.md#start-up) for the animation and how to turn it off.

## Build manually

Everything the launcher does can be done by hand, which is useful when
developing:

```bash
# The core and its tests
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j

# The observer
npm ci --prefix WebKit
npm run build --prefix WebKit

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
| `WebKit/dist/` | The observer bundle the server serves |

Run the server on its own and start a run from another terminal:

```bash
./build/dstns_server --port 8090 --logs logs
./launcher start --seed 382923          # attaches to the running server
```

## Start-up checks

Opened in a terminal, the launcher checks that this machine can run a simulation
before showing the dashboard, and says what to do when it cannot: the platform,
Rust, the build tools, both configuration files, the logs directory, the map
downloader and cache, the core and observer builds, the API port and SUMO. Every check
is listed in [Launcher: start-up checks](../guide/operator-cli.md#start-up-checks).
**Diagnostics** in the launcher can also run the core, HTTP, loading and observer
test suites on this machine.

## Optional: SUMO

SUMO is only needed for the [SUMO adapter](../components/sumo-adapter.md). DSTNS
finds `sumo` and `netconvert` through `SUMO_HOME`, the standard prefixes or
`PATH`, and uses them only if both start:

```bash
export SUMO_HOME=/opt/homebrew/share/sumo    # or wherever SUMO is installed
curl -s localhost:8090/api/v1/system/info | jq .sumo
```

!!! warning "A SUMO that cannot start"
    On macOS, a Homebrew upgrade can replace a library a locally built SUMO
    links against (`abseil`, `re2`). SUMO then fails with
    `dyld: Library not loaded` and DSTNS reports it unavailable. Rebuild or
    reinstall SUMO. See [Troubleshooting](../troubleshooting.md#sumo-reported-unavailable).

## Verify the installation

```bash
ctest --test-dir build --output-on-failure                  # 31 engine and HTTP suites
cargo test --release --manifest-path LaunchKit/Cargo.toml   # the launcher
npm test --prefix WebKit                                    # observer suites
```

Each should pass in about a minute. See [Testing](../development/testing.md)
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
| `WebKit/dist/`, `WebKit/node_modules/` | JavaScript build and dependencies | Yes |
| `LaunchKit/target/` | The launcher's build | Yes; rebuilt on next use |
| `config/launcher.env` | Whether the setup has been done | Yes; the setup runs again |
| `logs/` | Logs, journal, operator token | Yes; `./launcher reset` clears it |
| `data/maps/` | Downloaded city maps, and Dynamic Fastboot's next city (`next-world.json`) | Yes; downloaded again when needed |
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

??? failure "`the launcher is built with Rust, which was not found`"
    Install Rust from [rustup.rs](https://rustup.rs), open a new terminal so that
    `cargo` is on `PATH`, and run `./launcher` again.

??? failure "The launcher opens in compatibility mode"
    The terminal interface could not start in this terminal; the reason is in
    `logs/launcher.log`. See [Troubleshooting: the launcher](../troubleshooting.md#the-launcher).

??? failure "The FetchContent step hangs or fails"
    The first configure downloads two libraries from GitHub. Behind a proxy,
    set `HTTPS_PROXY`; offline, configure once on a connected machine and copy
    `build/_deps/`.

More in [Troubleshooting](../troubleshooting.md).
