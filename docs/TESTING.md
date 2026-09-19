# Testing Architecture & Verification

DSTNS includes multiple tiers of automated test suites:

1. **C++ Unit Tests (`dstns_tests`)**:
   - Seed parsing, SHA-256 digests, Philox RNG isolation, Wendland kernels, A* shortest path, and single-writer engine lifecycle.
2. **Property Invariant Tests (`dstns_prop_tests`)**:
   - Static topology and attachment invariants plus runtime bounds for congestion, rainfall, flood, building effects, progress, and effective speed. Closed and source-forbidden edges are excluded from sampled all-pairs routes.
3. **Replay Reproducibility Tests (`dstns_rep_tests`)**:
   - Dual compilation hashes and complete fixed-time engine snapshot equality for both synthetic-grid and OSM scenarios, using independent runtime instances.
4. **Performance Micro-benchmarks (`dstns_perf_tests`)**:
   - Measures compilation and 2,500 A* queries, requires all fixture routes to resolve, and fails if mean route latency exceeds the deliberately generous 500-microsecond regression ceiling.
5. **API Lifecycle Integration Smoke (`tests/api/api_smoke.py`)**:
   - Spawns C++ server on ephemeral port and runs full playback, control, seek, undo/redo, and termination sequences.
6. **SUMO Network Integration Smoke (`tests/integration/sumo_smoke.sh`)**:
   - Exports scenario into XML, runs `netconvert`, and advances headless SUMO.
7. **UI Test Suite (`ui-engine/tests/`)**:
   - Vitest coverage for observer transport, malformed data, bounded event requests, road color precedence and hit testing.

8. **Modernization invariants (`dstns_modern_tests`)**: independent heap controllers, demand effects, weighted congestion/EMA, clock-speed invariance, checkpoint replay, geographic metadata/projection and 10,000-controller stress.
9. **CLI saved seeds**: `python3 tests/cli/test_seeds.py` verifies SQLite roundtrip, uniqueness, IDs, pinned-map integrity and argument validation.
10. **Actual Chrome integration**: `node ui-engine/tests/browser.mjs` launches an isolated server and drives CLI startup, observer controls, motion preferences, event pages, inspection, responsive layouts, PDF download and failure recovery. Set `CHROME_BIN` for another Chrome executable.
11. **World regeneration and stepping (`dstns_world_tests`)**: exact one-step advances that always leave the run paused, step and seek equivalence, completion at 24:00:00, regeneration producing a new seed and run that starts paused with the requested speed, run guards, and a failed generation leaving the previous world's clock and state untouched, then a successful retry. Also the regeneration lifecycle (the replaced world is paused first, backpressure is not accumulated across the swap, and the new world starts with a clear window), the decimal and hexadecimal seed forms round-tripping to the same world, the 0.25 to 10 rate range, and every place reporting the core's demand type.
12. **Text boundaries (`dstns_utf8_tests`)**: UTF-8 validation and repair against truncated sequences, overlong encodings, surrogates and control bytes; a map whose tags carry mis-encoded bytes still compiling and serialising; a binary file being reported as a controlled error; and the serialisation guard that keeps a response sendable whatever reaches it.
13. **Map sourcing (`dstns_map_tests`)**: seeds resolving reproducibly, the catalogue's size, 200 seeds reaching at least 60 cities across six longitude bands and both hemispheres with no city dominating, extracts sized in real metres, and one cached extract shared by every district of a city.
14. **Observer model suites (`ui-engine/tests/*.test.ts`)**: 12 and 24 hour formatting and in-text time rewriting; notification copy, grouping, taxonomy, Do Not Disturb and the Auto Focus override; notification history retention, delivery classification and bounding; the place taxonomy, marker rules and legend demand; compact number formatting; the minimum viewport policy; Auto Focus geometry, rain re-framing and flood clustering; collision-aware tooltip placement; the telemetry recorder; configuration merging for DND lists and playback intervals; report derivation.
15. **Report layout (`ui-engine/tests/report.test.ts`)**: builds real PDFs with the embedded font from a busy day with hundreds of events and from an empty session, and asserts no overlapping text, text within margins, repeated table headers, the throughput chart, provenance labels, the 12 hour preference and professional copy.
16. **Observer shell (`ui-engine/tests/appShell.test.tsx`)**: the full interface against a mocked core, covering every rail control, the seven speeds, the global time format, the raw numeric seed and its copy, runtime status, the start-up stages the core reports, the refusal to squeeze the interface below the minimum size, world regeneration with staged progress and failure recovery, the notification capsule and the history behind it, DND, the focus override, rain framing growth, telemetry collapse and its side panel, the custom queue dropdown, the place legend, the settings drawer, layers, completion and backpressure suspension.
17. **HUD in Chrome (`ui-engine/tests/browser-hud.mjs`)**: a live core on a private port with the bundled fixture map; geometry at 2560, 1920, 1440, 1280 and the minimum 1024x640, where no element of the lower HUD, the rail, the map tools or telemetry may overlap; the notice shown below the minimum; tooltip collisions with neighbouring controls; speed and step reaching the engine; the paused state; the seed copied as a plain number; settings; layers; the notification capsule; telemetry collapsing to its strip with a temporary side panel; the place legend matching the markers drawn; the tutorial from start to Start Simulation; world regeneration; and PDF download. Screenshots are written to `artifacts/hud/`.

The operator CLI runs the core suites, the HTTP contract suite and the observer suites during startup, and validates `config/ui-config.json`, before a run begins.

Run existing core/API/SUMO/UI gates:
```bash
./scripts/test.sh
```

Optional large-map probe: attach `node ui-engine/tests/large-browser.mjs` to a paused run at 07:44:55 using `DSTNS_LARGE_URL` (default port 18194). It measures render cadence, pointer inspection, demand alerts and report download. `node ui-engine/tests/container-browser.mjs` verifies the isolated Compose saved weekend run; `DSTNS_CONTAINER_URL` overrides port 18195. These attach to existing task-owned runs and are not part of unattended core tests.
