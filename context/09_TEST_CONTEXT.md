# Test Context (09)

## Executed & Verified Test Suites
1. `dstns_unit_tests`: All primitive, RNG, scenario, graph, and engine tests PASS.
2. `dstns_property_invariants`: Static graph/attachment checks, dynamic normalized bounds, effective-speed bounds, and closed/forbidden route exclusion PASS.
3. `dstns_replay_reproducibility`: Independent grid and OSM engine runs match hashes and complete snapshots at a fixed virtual time PASS.
4. `dstns_performance_smoke`: Connected-fixture assertion and 500-microsecond mean A* regression ceiling PASS (3.6264 microseconds/query in the 2026-09-07 local Release run).
5. `api_smoke.py`: 89 HTTP API lifecycle and error-contract assertions PASS in the 2026-09-19 local run. It now asserts that topology is empty while IDLE (the server compiles no scenario, and performs no OSM download, until a run starts).
6. `sumo_smoke.sh`: Netconvert XML export and SUMO execution PASS.
7. `vitest`: 28 tests PASS — REST client contract, projection/metre-scale/scale-bar maths, and observer shell behaviour including the assertion that toggling a display layer issues no request to the core.
8. `dstns_map_sourcing`: seed->city determinism and spread, anchors inside their urban box, tile bbox size in true metres, filesystem-safe cache keys, cache reuse without network, hard failure with no fallback, truncated-cache rejection, and node/edge distances against haversine ground truth (0.13% / 0% worst error). Runs offline via `DSTNS_PYTHON=/usr/bin/false`.
9. `browser.mjs` / `large-browser.mjs`: live Chrome against real servers. The large-map probe on a 12,870-edge downloaded district measured 2,050 ms to interactive and ~60 FPS (frame median 16.7 ms, p95 16.8 ms).
10. `container-browser.mjs`: selectors updated for the alpha shell but NOT executed on 2026-09-19 (no Docker daemon available).

Run all tests via:
```bash
./scripts/test.sh
```
