# Testing

DSTNS is tested at five levels: native C++ suites against the engine library,
HTTP suites against a real server process, CLI suites against the launcher and
saved-seed store, Vitest suites against the observer with a mocked core, and
Chrome suites against a live core. This page lists every suite, what it
proves, and how to run it.

## Contents

- [Running everything](#running-everything)
- [Native suites (CTest)](#native-suites-ctest)
- [HTTP suites](#http-suites)
- [CLI suites](#cli-suites)
- [Observer suites](#observer-suites)
- [Browser suites](#browser-suites)
- [SUMO](#sumo)
- [Writing a test](#writing-a-test)
- [Sanitizer builds](#sanitizer-builds)

## Running everything

```bash
./scripts/test.sh
```

builds the core and the observer, runs CTest (native and HTTP suites), the
observer's Vitest suites, the full API smoke test, and the CLI suites. Run it
from a clean checkout to reproduce CI. Or step by step:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j
ctest --test-dir build --output-on-failure          # 14 native + HTTP targets
python3 tests/api/api_smoke.py --server build/dstns_server
python3 tests/cli/test_fetch_osm.py
python3 tests/cli/test_seeds.py
node --test tests/cli/*.test.mjs
python3 tests/cli/launcher_integration.py            # end to end, ~10 s
npm ci --prefix ui-engine && npm test --prefix ui-engine
```

The operator CLI runs the core, HTTP contract and observer suites during
start-up and validates `config/ui-config.json` before a run begins;
`./launcher test [all|unit|api|replay|benchmark|sumo|ui]` runs them on demand.

## Native suites (CTest)

Each target is a standalone executable under `build/`.

| CTest name | Executable | What it proves |
|---|---|---|
| `dstns_unit_tests` | `dstns_tests` | Seed parsing, SHA-256 digests, Philox RNG isolation, Wendland kernels, A* shortest paths, OSM road filtering and one-way handling (including untagged roundabouts and `shop=mall` classification), SUMO export omitting forbidden directions, bus-stop coverage, incident counts and spread, reset leaving nothing behind. 724 assertions |
| `dstns_modernization` | `dstns_modern_tests` | Independent heap controllers, demand effects, weighted congestion and its EMA, clock-speed invariance, checkpoint replay, geographic metadata and projection, a 10,000-controller stress |
| `dstns_demand` | `dstns_demand_tests` | Place taxonomy, diurnal curves, couplings and their stated factors, stop thinning |
| `dstns_asb` | `dstns_asb_tests` | The backpressure score, the Normal, Restricted and Async ladder, rate caps and recovery |
| `dstns_text_boundaries` | `dstns_utf8_tests` | UTF-8 repair of truncated, overlong, surrogate and control sequences; a mis-encoded map still compiling; binary files reported as controlled errors |
| `dstns_map_sourcing` | `dstns_map_tests` | Seeds resolving reproducibly; 200 seeds reaching many cities across six longitude bands and both hemispheres; true-metre scale; the cache sweep keeping, pruning and clearing extracts and always removing `.part` and `.progress` leftovers |
| `dstns_loading_concurrency` | `dstns_loading_tests` | Compile lease, cancellation and status reads during a compile |
| `dstns_world_and_stepping` | `dstns_world_tests` | Exact steps that leave the run paused; step and seek equivalence; completion at 24:00:00 by playing, stepping or seeking; regeneration with a fresh seed, failure leaving the old world untouched, and backpressure ignoring the swap; edge overrides surviving a backwards seek; undo and redo of signal toggles; surge and weather bounds; demand types |
| `dstns_property_invariants` | `dstns_prop_tests` | Topology and attachment invariants; congestion, rain, flood, building effect, progress and speed staying in bounds over a run |
| `dstns_replay_reproducibility` | `dstns_rep_tests` | Two independent compilations and engines agreeing on every hash and on full snapshots, for a grid and an OSM map |
| `dstns_performance_smoke` | `dstns_perf_tests` | 2,500 A* queries all resolving, with mean latency under a deliberately generous 500 µs. See [Performance](PERFORMANCE.md) |
| `dstns_http_loading` | `tests/api/loading_smoke.py` | 30 concurrent reads, start-up, conflicts, regeneration, cancellation, failure and retry over HTTP |
| `dstns_http_termination` | `tests/api/termination_smoke.py` | Terminating a running session, and terminating during a stalled map download, kills the downloader's process group and exits 0 |
| `dstns_http_hardening` | `tests/api/hardening_smoke.py` | Cross-site writes refused, same-origin and Origin-less writes allowed, no GET shutdown, IDs not wrapping, out-of-day seeks and negative query numbers refused, weather, surge and SUMO bounds |

Run one target and see its output:

```bash
ctest --test-dir build -R dstns_world --output-on-failure
./build/dstns_world_tests
```

`dstns_replay_verify` (in `tools/`) is a standalone tool that checks
reproducibility of a given seed and configuration, the same way the replay
suite does. See [Reproducibility](REPRODUCIBILITY.md).

## HTTP suites

`tests/api/api_smoke.py` spawns a server on a free port and walks the whole
API: health, system info, start, status, topology, snapshot, every view,
pagination, controls, seek, step, undo and redo, news, logs, regeneration, SUMO
export, termination, and the SQLite journal (133 assertions). The SUMO
simulate step runs only when `/system/info` reports SUMO available.

```bash
python3 tests/api/api_smoke.py --server build/dstns_server
python3 tests/api/api_smoke.py --url http://127.0.0.1:8090   # against a running server
```

The three CTest-registered HTTP suites above take the server path from
`DSTNS_SERVER` and can be run directly with `python3`.

## CLI suites

| Command | What it proves |
|---|---|
| `python3 tests/cli/test_fetch_osm.py` | The downloader's endpoint fallback, progress sidecar, atomic writes and failure messages |
| `python3 tests/cli/test_seeds.py` | Saved seeds: SQLite round trip, uniqueness, IDs, pinned-map integrity, argument validation |
| `node --test tests/cli/artifacts.test.mjs` | Build outputs rebuilt when their sources change, including nested UI files |
| `python3 tests/cli/launcher_integration.py` | Both launchers end to end: a stale UI is rebuilt, an old server on the port is avoided, a real OSM map loads (about 1,200 nodes), and the Python launcher reattaches without restarting the run |

## Observer suites

```bash
npm test --prefix ui-engine          # Vitest, jsdom
npx --prefix ui-engine tsc -b        # type check
```

23 files, 284 tests. The main ones:

| File | Covers |
|---|---|
| `appShell.test.tsx` | The whole interface against a mocked core: every rail control, the speeds, time format, seed display and copy, start-up stages, minimum size, regeneration with staged progress and failure, notifications and history, DND, Auto Focus, telemetry, the place legend, settings, layers, completion and its next actions (asserting dialogs persist past their exit transition), backpressure suspension, and copy rules |
| `api.test.ts` | The client: error messages, non-JSON error statuses, malformed responses, envelope validation, bounded requests |
| `report.test.ts` | Real PDFs from a busy day and an empty one: no overlapping text, margins, repeated headers, chart, provenance, 12-hour time |
| `uiConfig.test.ts` | Merging and bounding `ui-config.json` |
| `*Model.test.ts` | Notification grouping and history, telemetry, places and legends, Auto Focus geometry, tooltip placement, time formatting |

## Browser suites

These drive installed Chrome (`CHROME_BIN` overrides the executable) against a
live core on a private port, and write screenshots and PDFs as evidence.

| Command | What it proves | Evidence |
|---|---|---|
| `node ui-engine/tests/browser.mjs` | CLI start-up, observer controls, motion preferences, event pages, inspection, responsive layouts, PDF download, failure recovery | `artifacts/modernization/browser/` |
| `node ui-engine/tests/browser-hud.mjs` | The HUD at 2560 down to 1024×640 with no overlaps, tooltips, speed and step reaching the engine, seed copy, settings, layers, notifications, telemetry, legend, tutorial, regeneration, PDF | `artifacts/hud/` |
| `node ui-engine/tests/large-browser.mjs` | Render cadence and inspection on a large paused run (`DSTNS_LARGE_URL`, default port 18194) | |
| `node ui-engine/tests/container-browser.mjs` | The Compose deployment (`DSTNS_CONTAINER_URL`, default port 18195) | |

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
[Troubleshooting](TROUBLESHOOTING.md#sumo-reported-unavailable).

## Writing a test

- **Engine behaviour** goes in `tests/unit/world_tests.cpp` (lifecycle,
  controls, time travel) or `tests/unit/test_main.cpp` (compiler, loader,
  routing). Both use a `check(condition, message)` helper; `world_tests.cpp`
  prints each check.
- **An OSM parsing case** gets a small fixture in `tests/fixtures/` and a check
  in `test_main.cpp`. Keep fixtures to a handful of nodes.
- **An HTTP contract** goes in `tests/api/hardening_smoke.py` (validation,
  security) or `api_smoke.py` (behaviour).
- **Observer behaviour** goes in `ui-engine/tests/appShell.test.tsx` with
  `mockApi({...})`. When asserting that something persists, wait past any
  transition first: `findBy*` polls and will pass on an element that existed
  for only a moment.
- Confirm a regression test fails on the unfixed code before relying on it.

One C++ pitfall to avoid in tests: never range-for over a member of a
temporary, as in `for (auto& n : engine.topology()["data"]["nodes"])`. The
temporary JSON is destroyed before the loop body runs (until C++23). Bind it to
a local first.

## Sanitizer builds

```bash
cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DDSTNS_ENABLE_SANITIZERS=ON
cmake --build build-asan -j && ctest --test-dir build-asan --output-on-failure
```

AddressSanitizer and UndefinedBehaviorSanitizer instrument the library and
every test.
