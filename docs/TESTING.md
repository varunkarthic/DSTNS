# Testing Architecture & Verification

DSTNS includes 4 tiers of automated test suites:

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
   - Vitest suite for UI client decoding and overlay client dispatching.

Run all tests:
```bash
./scripts/test.sh
```
