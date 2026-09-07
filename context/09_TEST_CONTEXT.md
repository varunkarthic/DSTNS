# Test Context (09)

## Executed & Verified Test Suites
1. `dstns_unit_tests`: All primitive, RNG, scenario, graph, and engine tests PASS.
2. `dstns_property_invariants`: Static graph/attachment checks, dynamic normalized bounds, effective-speed bounds, and closed/forbidden route exclusion PASS.
3. `dstns_replay_reproducibility`: Independent grid and OSM engine runs match hashes and complete snapshots at a fixed virtual time PASS.
4. `dstns_performance_smoke`: Connected-fixture assertion and 500-microsecond mean A* regression ceiling PASS (3.6264 microseconds/query in the 2026-09-07 local Release run).
5. `api_smoke.py`: 79 HTTP API lifecycle and error-contract assertions PASS in the 2026-09-07 local run.
6. `sumo_smoke.sh`: Netconvert XML export and SUMO execution PASS.
7. `vitest`: UI Engine API decoding and overlay client PASS.

Run all tests via:
```bash
./scripts/test.sh
```
