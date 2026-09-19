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
11. **World regeneration and stepping (`dstns_world_tests`)**: exact one-step advances that always leave the run paused, step and seek equivalence, completion at 24:00:00, regeneration producing a new seed and run that starts paused with the requested speed, run guards, and a failed generation leaving the previous world's clock and state untouched, then a successful retry.
12. **Observer model suites (`ui-engine/tests/*.test.ts`)**: 12 and 24 hour formatting and in-text time rewriting; notification copy, grouping, taxonomy, Do Not Disturb and the Auto Focus override; Auto Focus geometry, rain re-framing and flood clustering; collision-aware tooltip placement; the telemetry recorder; configuration merging for DND lists and playback intervals; report derivation.
13. **Report layout (`ui-engine/tests/report.test.ts`)**: builds real PDFs with the embedded font from a busy day with hundreds of events and from an empty session, and asserts no overlapping text, text within margins, repeated table headers, the throughput chart, provenance labels, the 12 hour preference and professional copy.
14. **Observer shell (`ui-engine/tests/appShell.test.tsx`)**: the full interface against a mocked core, covering every rail control, speed radios, the global time format, seed copy, runtime status, world regeneration with staged progress and failure recovery, the notification capsule, DND, the focus override, rain framing growth, the settings drawer, layers, completion and backpressure suspension.
15. **HUD in Chrome (`ui-engine/tests/browser-hud.mjs`)**: a live core on a private port with the bundled fixture map; geometry checks at 1440, 1100 and 760 px, tooltip collisions with neighbouring controls, speed and step reaching the engine, the paused state, clipboard copy, settings, layers, the notification capsule, the tutorial from start to Start Simulation, world regeneration and PDF download. Screenshots are written to `artifacts/hud/`.

The operator CLI runs the core suites, the HTTP contract suite and the observer suites during startup, and validates `config/ui-config.json`, before a run begins.

Run existing core/API/SUMO/UI gates:
```bash
./scripts/test.sh
```

Optional large-map probe: attach `node ui-engine/tests/large-browser.mjs` to a paused run at 07:44:55 using `DSTNS_LARGE_URL` (default port 18194). It measures render cadence, pointer inspection, demand alerts and report download. `node ui-engine/tests/container-browser.mjs` verifies the isolated Compose saved weekend run; `DSTNS_CONTAINER_URL` overrides port 18195. These attach to existing task-owned runs and are not part of unattended core tests.
