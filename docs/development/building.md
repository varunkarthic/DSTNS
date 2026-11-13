# Building from source

The details behind `./launcher`'s automatic build: CMake options, targets,
build types, sanitizers, the observer toolchain and editor setup. For first-time
setup see [Installation](../getting-started/installation.md).

## The native build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j
```

### Options

| Option | Default | Effect |
|---|---|---|
| `CMAKE_BUILD_TYPE` | none | Use `Release` for running, `Debug` or `RelWithDebInfo` for debugging |
| `DSTNS_BUILD_TESTS` | `ON` | Build the test executables and register them with CTest |
| `DSTNS_ENABLE_SANITIZERS` | `OFF` | AddressSanitizer and UndefinedBehaviorSanitizer on the library and everything linked to it |

### Dependencies

| Dependency | How it is found |
|---|---|
| nlohmann/json 3.12.0 | Downloaded by CMake `FetchContent`, hash-checked |
| cpp-httplib 0.28.0 | Downloaded by `FetchContent`; built with zlib compression, without Brotli |
| SQLite 3 | `find_package(SQLite3)` |
| zlib | Required by cpp-httplib |
| Threads | `find_package(Threads)` |
| CoreFoundation, CFNetwork | macOS only, for cpp-httplib |

### Targets

| Target | Kind | Purpose |
|---|---|---|
| `dstns_core` | static library | Everything in `Core/core-legacy/src/` |
| `dstns_server` | executable | The server |
| `dstns_scenario_export` | tool | Compile a scenario and write SUMO files |
| `dstns_replay_verify` | tool | Compile and run a seed twice; compare every hash and snapshot |
| `dstns_road_index` | tool | Inspect a map's road graph |
| `dstns_benchmark` | tool | Compilation, routing and snapshot timings |
| `dstns_tests`, `dstns_*_tests` | tests | See [Testing](testing.md) |

Build one target: `cmake --build build --target dstns_server`.

### Compiler flags

The library builds with `-Wall -Wextra -Wpedantic -Wshadow`; tests add
`-Werror`. Keep the build warning-free.

### Sanitizers

```bash
cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DDSTNS_ENABLE_SANITIZERS=ON
cmake --build build-asan -j
ctest --test-dir build-asan --output-on-failure
```

### A fresh configure

After a compiler or system-library upgrade (for example Homebrew replacing
OpenSSL), the CMake cache can point at files that no longer exist, failing with
`No rule to make target '…/libssl.dylib'`:

```bash
cmake --fresh -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
```

!!! warning "Filtering build output hides failures"
    `cmake --build build | grep error:` misses `make: *** … Error 2` lines,
    and a failed link leaves the old executable in place. Check the exit
    status, or grep for `\*\*\*` too.

## The observer

```bash
npm ci --prefix WebKit          # exact dependencies from package-lock.json
npm run build --prefix WebKit   # type check (tsc -b) and bundle into WebKit/dist
npm test --prefix WebKit        # Vitest
npm run dev --prefix WebKit     # Vite dev server on 5173 with hot reload
```

The dev server proxies `/api`, `/health` and `/media` to
`http://127.0.0.1:$DSTNS_API_PORT` (default 8090), so requests stay
same-origin and pass the server's cross-site check. `scripts/dev.sh` starts
the server and the dev server together.

To serve the observer from somewhere else entirely, build it with
`VITE_DSTNS_API_URL=https://api.example.org npm run build`, and allow that
origin on the server with `DSTNS_ALLOWED_ORIGINS`.

## The launcher

```bash
./launcher help                                              # builds it first, if its sources changed
cargo build --release --manifest-path LaunchKit/Cargo.toml   # or by hand
cargo test --release --manifest-path LaunchKit/Cargo.toml
```

The launcher is a Rust program in `LaunchKit/`: [ratatui](https://ratatui.rs) and
crossterm for the terminal interface, ureq for HTTP, rusqlite (against the system's
SQLite) for saved seeds, and nothing that downloads at run time. The `launcher` script
builds it with `cargo build --release` when any file under `LaunchKit/src`, `assets`,
`Cargo.toml` or `Cargo.lock` is newer than the binary, then runs it; `CARGO_TARGET_DIR`
moves the build, and a synced checkout keeps it in the local cache.

| Path | What it is |
|---|---|
| `src/cli.rs`, `main.rs` | The command line: parsing, dispatch, help |
| `src/console.rs` | The console: splitting lines on `\|`, `&&`, `\|\|` and `;`, the built-in readers and filters |
| `src/config.rs` | Every setting, its validation, the rules between them, and what reaches the server |
| `src/server.rs`, `session.rs`, `simulation.rs` | Finding, starting and stopping the server; a run's lifecycle |
| `src/supervisor.rs`, `apps.rs` | Applications: the catalogue, starting them, waiting until ready, reloading |
| `src/environment.rs`, `testing.rs`, `buildplan.rs` | The start-up checks, the test stages, building what changed |
| `src/modules/` | Commands that add pages: applications, Fabric, Fast Boot, Demo Mode, the MCP Handler |
| `src/tui/` | The terminal interface: `theme.rs`, `widgets.rs`, the command bar (`shell.rs`), and one file per page in `screens/` |
| `src/interface.rs` | Compatibility mode, for a terminal the interface cannot use |

The launcher rebuilds the core and the observer only when their sources are newer than
their last builds.

## The container

```bash
docker build -t dstns .
docker build -t dstns:sumo --build-arg WITH_SUMO=1 .
```

See [Docker](../deployment/docker.md#the-image).

## Editor setup

CMake writes `build/compile_commands.json`
(`CMAKE_EXPORT_COMPILE_COMMANDS=ON`), which clangd, CLion and the VS Code C++
extensions read for accurate navigation and diagnostics. For clangd, link it
to the root once:

```bash
ln -s build/compile_commands.json .
```

For the observer, open `WebKit/` as the TypeScript project root.

### Terminal wordmark

The launcher's wordmark is text, in `LaunchKit/assets/logo.txt` and `logo-small.txt`:
the outlines of `docs/assets/logo-wordmark.svg` drawn in Unicode half-block characters,
at two sizes. The launcher picks the one that fits, and plain `D S T N S` where neither
does or Unicode is unavailable. The start-up animates it cell by cell, so any change to
the artwork animates too. After changing it, look at the start-up at both sizes:
`DSTNS_SNAPSHOT_PAGES=splash cargo test --release snapshots -- --ignored --nocapture`.

## Release tooling

`tools/release/main.cpp` builds `dstns_release`, which CI uses to publish the image:

| Command | Does |
|---|---|
| `dstns_release metadata` | The image's version (from `CMakeLists.txt`), revision, build time and channel: `stable` only for `main` and the exact version tag; a tag for another version is refused. Also written to `GITHUB_OUTPUT` |
| `dstns_release publish --digests DIR` | Puts both platforms' images under one candidate index, checks it has linux/amd64 and linux/arm64, promotes that immutable digest to the public tags, and reads every tag back |
| `dstns_release smoke IMAGE --arch A [--revision R]` | Runs the packaged image: its labels, health with a running map, the observer's assets, provenance, a non-root user, replacing the run, a clean stop |
| `dstns_release headers --check \| --fix` | The SPDX licence header on every source file, C++, Rust, TypeScript, shell, CSS and the rest |

It needs only the JSON and HTTP headers, so `cmake --build build --target dstns_release`
builds it on its own.
