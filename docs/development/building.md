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
| `dstns_core` | static library | Everything in `src/` |
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
npm ci --prefix ui-engine          # exact dependencies from package-lock.json
npm run build --prefix ui-engine   # type check (tsc -b) and bundle into ui-engine/dist
npm test --prefix ui-engine        # Vitest
npm run dev --prefix ui-engine     # Vite dev server on 5173 with hot reload
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
./launcher help
python3 tests/launcher/test_core.py          # launcher operations
python3 tests/launcher/test_interfaces.py    # command line, fallback and terminal interface
```

The launcher is the Python package `dstns_launcher/`: `core/` holds every operation,
`tui/` the Textual interface and `fallback/` compatibility mode. Its build step
fingerprints the core's and the observer's sources
(stored in `build/.launcher-source` and `ui-engine/dist/.launcher-source`)
and rebuilds only what changed.

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

For the observer, open `ui-engine/` as the TypeScript project root.

### Terminal wordmark

The launcher's checked-in text artwork is generated from
`docs/assets/logo-wordmark.svg`. After changing that SVG, regenerate it with:

```bash
python3 scripts/launcher-logo.py
```

The script samples the filled SVG outlines into Unicode half-block characters at
two sizes. It uses only the Python standard library and is not run at startup.
The launcher selects artwork that fits the terminal and falls back to plain text
in compact or non-Unicode terminals. Review the splash at both sizes after
regeneration; terminal font proportions can vary.
