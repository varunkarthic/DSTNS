# Testing

Every test is either C++ (the engine, the HTTP API, the downloader, the release tooling),
Rust (the launcher) or TypeScript (the observer). Nothing needs Python.

| Suites | Language | Run with | Count |
|---|---|---|---|
| Engine: unit, property, replay, performance | C++ | `ctest` | 13 programs |
| HTTP API, downloader, launcher end to end, release tooling | C++ | `ctest` | 18 programs |
| Launcher: commands, console, settings, the terminal interface | Rust | `cargo test` | 58 tests |
| Observer | TypeScript (Vitest, jsdom) | `npm test` | 476 tests in 38 files |
| Browser | JavaScript (Playwright, installed Chrome) | `node WebKit/tests/browser*.mjs` | 4 suites |

## Running everything

```bash
./scripts/test.sh                                         # build, then ctest, cargo test and npm test
./launcher test all                                       # the same stages, with a summary, from the launcher
```

Or one layer at a time:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j
ctest --test-dir build -j6 --output-on-failure            # engine and HTTP suites
cargo test --release --manifest-path LaunchKit/Cargo.toml # the launcher
npm test --prefix WebKit                                  # the observer
```

`./launcher test SCOPE` runs one stage: `unit` (all of `ctest`), `api` (the HTTP suites
alone), `replay`, `benchmark`, `sumo`, `launcher`, `ui`, or `all`.

## Native suites (CTest)

Each target is a standalone executable under `build/`.

| CTest name | Executable | What it proves |
|---|---|---|
| `dstns_unit_tests` | `dstns_tests` | Seed parsing, SHA-256 digests, Philox RNG isolation, Wendland kernels, A* shortest paths, OSM road filtering and one-way handling (including untagged roundabouts and `shop=mall` classification), SUMO export omitting forbidden directions and writing loadable bus stops, bus-stop coverage, incident counts and spread, reset leaving nothing behind. 726 assertions |
| `dstns_modernization` | `dstns_modern_tests` | Independent heap controllers, demand effects, weighted congestion and its EMA, clock-speed invariance, checkpoint replay, geographic metadata and projection, a 10,000-controller stress |
| `dstns_demand` | `dstns_demand_tests` | Place taxonomy, diurnal curves, couplings and their stated factors, stop thinning |
| `dstns_asb` | `dstns_asb_tests` | The backpressure score, the Normal, Restricted and Async ladder, rate caps and recovery |
| `dstns_text_boundaries` | `dstns_utf8_tests` | UTF-8 repair of truncated, overlong, surrogate and control sequences; a mis-encoded map still compiling; binary files reported as controlled errors |
| `dstns_map_sourcing` | `dstns_map_tests` | The downloader receiving a southern-hemisphere box as one `--bbox=` argument; seeds resolving reproducibly; 200 seeds reaching many cities across six longitude bands and both hemispheres; true-metre scale; the cache sweep keeping, pruning and clearing extracts and always removing `.part` and `.progress` leftovers |
| `dstns_loading_concurrency` | `dstns_loading_tests` | Compile lease, cancellation and status reads during a compile |
| `dstns_world_and_stepping` | `dstns_world_tests` | Exact steps that leave the run paused; step and seek equivalence; completion at 24:00:00 by playing, stepping or seeking; regeneration with a fresh seed, failure leaving the old world untouched, and backpressure ignoring the swap; edge overrides surviving a backwards seek; undo and redo of signal toggles; surge and weather bounds; demand types |
| `dstns_property_invariants` | `dstns_prop_tests` | Topology and attachment invariants; congestion, rain, flood, building effect, progress and speed staying in bounds over a run |
| `dstns_replay_reproducibility` | `dstns_rep_tests` | Two independent compilations and engines agreeing on every hash and on full snapshots, for a grid and an OSM map |
| `dstns_narration` | `dstns_narrator_tests` | The facts a model is given (no internal IDs, percentages, HH:MM) and the checks on what it writes (invented numbers, injuries, speculation, labels, length); the narrator's queue, bound, back-off, refusals and persistent cache; that an engine with a narrator produces byte-identical snapshots and news text to one without, with every incident narrated; the cached topology response equal to the built one; large snapshots assembled in order |
| `dstns_performance_smoke` | `dstns_perf_tests` | 2,500 A* queries all resolving, with mean latency under a deliberately generous 500 µs. See [Performance](../deployment/performance.md) |
Run one target and see its output:

```bash
ctest --test-dir build -R dstns_world --output-on-failure
./build/dstns_world_tests
```

`dstns_replay_verify` (in `tools/`) is a standalone tool that checks
reproducibility of a given seed and configuration, the same way the replay
suite does. See [Reproducibility](../concepts/reproducibility.md).

## HTTP suites

Each is a C++ program of its own, in `tests/http/`, built to `build/http-tests/`, which
starts a real `dstns_server` on a free port with a private logs directory, and talks to it
over HTTP. None reaches the network: map downloads go to stand-in Overpass servers the test
runs itself, or to the bundled fixtures. ctest runs each as `dstns_http_<name>`, with
`DSTNS_SERVER` set to the server it built.

| CTest name | Program | What it proves |
|---|---|---|
| `dstns_http_api` | `api` | The API end to end, 123 requests: health, a run from start to stop, every view and control, seeking and stepping, a new world, compression, news, logs, paging, the SUMO export, a graceful exit |
| `dstns_http_loading` | `loading` | 30 concurrent reads while a map is held back behind a FIFO, start-up, conflicts, regeneration, cancellation by reset, failure and retry |
| `dstns_http_termination` | `termination` | Terminating a running session, and terminating during a stalled map download, kills the downloader's process group and exits 0 |
| `dstns_http_hardening` | `hardening` | Cross-site writes refused, DNS rebinding refused, loopback names accepted, CORS only for the own origin, no GET shutdown, IDs not wrapping, every bound |
| `dstns_http_robustness` | `robustness` | Twenty hostile values in every field of 31 routes, malformed and deeply nested bodies, a 17 MiB body, hostile paths: never a 5xx, and the server still up. Then every protection that was once missing |
| `dstns_http_fabric_contract` | `fabric_contract` | The recorded HTTP contract: 155 calls replayed against `fabric_contract.golden.json` (statuses, types, headers, response shapes) |
| `dstns_http_fabric_apps` | `fabric_apps` | Registration, identity and conflicts, capabilities, settings isolation and migration, persistence across a restart, leases, lossless delivery, overlays checked against the network |
| `dstns_http_fabric_platform` | `fabric_platform` | Discovery, atomic UI batches, storage, messages, subscriptions and timers on a real run, signing and replay protection, frames, the audit chain, launch proposals, a tampered store rejected |
| `dstns_http_fabric_direction` | `fabric_direction` | Directing the view: grants, closed lists and ranges, rate limits, outcomes, held layers released, nothing ever saved |
| `dstns_http_fabric_launch` | `fabric_launch` | The operator's switches, each on a server of its own: presentation (the adaptive film and the whole film never both on, `demo_scenes`), performance, web interfaces, grid components, reloading with a launch key |
| `dstns_http_launcher_apps` | `launcher_apps` | The Rust launcher end to end: two applications (the test program itself, in `--app` mode), the run waiting until both are ready, a reload coming back as itself, everything stopping with the launcher, and a required application that fails stopping a run |
| `dstns_http_narration` | `narration` | Against a stand-in Chat Completions server: facts without identifiers, narrations in the feed and through the cursor, and `--narrator off` leaving the feed unchanged |
| `dstns_http_observer_hold` | `observer_hold` | A world waits for an observer showing its start-up, and for nobody else; a pause stays a pause |
| `dstns_http_another_city` | `another_city` | Every retry after a failed download chooses a different city |
| `dstns_http_fastboot` | `fastboot` | A city packed in advance is unpacked whole and used, with no download; a damaged pack leaves nothing half-written |
| `dstns_http_dynamic_fastboot` | `dynamic_fastboot` | The next city fetched in the background and named in `next-world.json`; kept through a cache sweep; taken by the next world with no download; a staged world prepared while the current one runs, committed and discarded; `eta_s` and `eta_confident`; the switch off |
| `dstns_http_fetch_osm` | `fetch_osm` | The downloader against stand-in mirrors: failover on refused connections and shed load, retries, compression, silence, error remarks, offline reports in one line, endpoints from the environment |
| `dstns_http_docs_coverage` | `docs_coverage` | Every route the server lists is in `openapi.yaml` and in Every endpoint |
| `dstns_http_release` | `release` | `dstns_release` against a stand-in `docker`: metadata channels, two-platform promotion, read-back, licence headers on every source file |

The programs share `tests/http/harness.hpp`:

| Piece | Gives |
|---|---|
| `Server` | `dstns_server` on a free port with its own logs, started and healthy, with the operator's token; `call`, `op` (as the operator) and `raw` (a body sent as it is) |
| `request` | One HTTP request, with a timeout; a `Reply` with the status, parsed body, headers and text |
| `Process`, `run` | A program in a process group of its own, without the caller's `DSTNS_` settings, its output captured (all of it, or stderr only), stopped with SIGTERM then SIGKILL |
| `Upstream` | An HTTP service on a free port, answering as the test says: a stand-in Overpass, Chat Completions server, or anything else |
| `TempDir`, `until`, `EXPECT` | A directory removed afterwards; a wait for a condition; a check that says what failed, where, and with what reply |

A failing check prints its file, line, condition and whatever was given to explain it, and
exits 1. An exception nothing caught names the last check reached. Run one directly to see
its output:

```bash
./build/http-tests/dynamic_fastboot
DSTNS_SERVER=build/dstns_server ./build/http-tests/robustness
```

`fabric_contract --record` rewrites the baseline. Use it only for a deliberate, documented
change to the contract.

## Launcher suites

```bash
cargo test --release --manifest-path LaunchKit/Cargo.toml
```

| Module | Covers |
|---|---|
| `console` | Splitting lines on operators outside quotes; every filter; `&&`, `\|\|`, `;`, exit statuses, `command not found` |
| `config` | Every setting's validation; the [rules](../guide/operator-cli.md#settings-that-go-together) that keep conflicting settings apart; `demo.scenes`; the presentation and server switches; the prepared seed Dynamic Fastboot leaves |
| `tui` | Every layout drawing at every size without overflowing; a terminal too small saying so; the dashboard driven by keyboard; every page opening; the command bar moving about as a shell does, walking its history, suggesting and completing; the setup walking through and remembering; colour coming down to none |
| `widgets` | The order list: items turned on and off and moved, and the arrows kept inside it |
| `modules::mcp` | The MCP handshake, protocol versions, tools from the endpoint index, refused changes |
| `process`, `paths`, `seeds`, `apps`, `supervisor`… | Output streamed and kept, failures with their output, cancellation stopping a whole process group; synced folders; the seed store; application validation and command expansion |

A snapshot of every page, as text, at any size, for looking over by eye:

```bash
cd LaunchKit
DSTNS_SNAPSHOT_SIZES=120x35,80x24 cargo test --release snapshots -- --ignored --nocapture
DSTNS_SNAPSHOT_PAGES=splash,config/Demo cargo test --release snapshots -- --ignored --nocapture
```

## Observer suites

```bash
npm test --prefix WebKit          # Vitest, jsdom
npx --prefix WebKit tsc -b        # type check
```

38 files, 476 tests. The main ones:

| File | Covers |
|---|---|
| `appShell.test.tsx` | The whole interface against a mocked core: every rail control, the speeds, time format, seed display and copy, start-up stages, minimum size, regeneration with staged progress and failure, a new world prepared while the dialog is open and forgotten on Cancel, notifications and history, DND, Auto Focus, telemetry, the place legend, settings, layers, completion and its next actions (asserting dialogs persist past their exit transition), backpressure suspension, and copy rules |
| `api.test.ts` | The client: error messages, non-JSON error statuses, malformed responses, envelope validation, bounded requests |
| `report.test.ts` | Real PDFs from a busy day and an empty one: no overlapping text, margins, repeated headers, chart, provenance, 12-hour time |
| `uiConfig.test.ts` | Merging and bounding `ui-config.json` |
| `stacking.test.ts` | Dialogs paint above the header: the workspace is lifted to the scrim's level while a dialog is open |
| `*Model.test.ts` | Notification grouping and history, telemetry, places and legends, Auto Focus geometry, tooltip placement, time formatting; a narration replacing the summary while title, details and the core message are kept |
| `narration.test.ts` | Late narrations attached to news already held, without disturbing untouched items |
| `bootFilm.test.ts` | Every scene of the film and Demo Mode: finite, never repeating a layout, always moving, captions of one or two words; landing on the roads in order |

## Browser suites

These drive installed Chrome (`CHROME_BIN` overrides the executable) against a
live core on a private port, and write screenshots and PDFs as evidence.

| Command | What it proves | Evidence |
|---|---|---|
| `node WebKit/tests/browser.mjs` | CLI start-up, observer controls, motion preferences, event pages, inspection, responsive layouts, PDF download, failure recovery | `artifacts/modernization/browser/` |
| `node WebKit/tests/browser-hud.mjs` | The HUD at 2560 down to 1280×640 with no overlaps, scrolling with the pointer on cut-off text, a bounce played off the main thread, tooltips, speed and step reaching the engine, seed copy, settings, layers, notifications, telemetry, legend, tutorial, regeneration, PDF | `artifacts/hud/` |
| `node WebKit/tests/large-browser.mjs` | Render cadence and inspection on a large paused run (`DSTNS_LARGE_URL`, default port 18194) | |
| `node WebKit/tests/container-browser.mjs` | The Compose deployment (`DSTNS_CONTAINER_URL`, default port 18195) | |

The last two attach to runs you start yourself and are not part of unattended
runs.

## SUMO

```bash
tests/integration/sumo_smoke.sh
./launcher test sumo
```

Exports a scenario, runs `netconvert`, and advances headless SUMO. Both need a
working SUMO; check with `curl -s localhost:8090/api/v1/system/info`, which
reports `sumo.available` only if `sumo` and `netconvert` both start. See
[Troubleshooting](../troubleshooting.md#sumo-reported-unavailable).

## Adding tests

- **Engine behaviour** goes in `tests/unit/world_tests.cpp` (lifecycle, controls, time
  travel) or `tests/unit/test_main.cpp` (compiler, loader, routing).
- **An HTTP contract** goes in the `tests/http/` program it belongs with
  (`hardening.cpp` for validation and security, `api.cpp` for behaviour), or a new one:
  add its name to `DSTNS_HTTP_TESTS` in `CMakeLists.txt`.
- **An OSM parsing case** gets a small fixture in `tests/fixtures/` and a check in
  `test_main.cpp`. Keep fixtures to a handful of nodes.
- **Launcher behaviour** goes in the `#[cfg(test)]` module of the file it is in; anything
  on screen in `LaunchKit/src/tui/mod.rs`, which draws pages with ratatui's `TestBackend`.
- **Observer behaviour** goes in `WebKit/tests/appShell.test.tsx` with `mockApi({...})`.
  When asserting that something persists, wait past any transition first: `findBy*` polls
  and will pass on an element that existed for only a moment.
- Confirm a regression test fails on the unfixed code before relying on it.

Two C++ pitfalls, both met while writing these suites:

- Never range-for over a member of a temporary, as in
  `for (auto& n : server.call(...).data().at("items"))`: the temporary is destroyed before
  the loop body runs (until C++23). Bind it to a local first, or copy it: `json(...)`.
- `nlohmann::json` converts to `std::pair` by reading an array, so `set.insert({j["a"], j["b"]})`
  throws; say `.get<std::string>()` for each.

## Sanitizer builds

```bash
cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DDSTNS_ENABLE_SANITIZERS=ON
cmake --build build-asan -j && ctest --test-dir build-asan --output-on-failure
```

AddressSanitizer and UndefinedBehaviorSanitizer instrument the library and
every test.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

| Job | Runs |
|---|---|
| `core` | Configure and build on Ubuntu 24.04, `ctest` (every engine and HTTP suite, the launcher end to end), `cargo test` for the launcher, replay verification, and `dstns_release headers --check` |
| `observer` | `npm ci`, type check, Vitest, production build |
| `docs` | `mkdocs build --strict` and OpenAPI validation |
| `docker` | Build the image, then `dstns_release smoke` on it: health, a running map, the observer's assets, provenance labels, a non-root user, replacing the run, a clean stop |

`docker-publish.yml` builds each platform's image, smoke-tests it on its own architecture,
and only then promotes both under one index with `dstns_release publish`, which reads every
tag back. CodeQL analyses the C++, TypeScript, Rust and the remaining Python examples.

