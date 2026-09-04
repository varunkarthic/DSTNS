# Test Context (09)

## Executed & Verified Test Suites
1. `dstns_unit_tests`: All primitive, RNG, scenario, graph, and engine tests PASS.
2. `dstns_property_invariants`: Physical parameter bounds and twin reciprocity tests PASS.
3. `dstns_replay_reproducibility`: Dual compile hash matching and checkpoint seek tests PASS.
4. `dstns_performance_smoke`: Scenario compile, routing (5.7 $\mu$s), and snapshot throughput tests PASS.
5. `api_smoke.py`: 15 HTTP API lifecycle assertions PASS.
6. `sumo_smoke.sh`: Netconvert XML export and SUMO execution PASS.
7. `vitest`: UI Engine API decoding and overlay client PASS.

Run all tests via:
```bash
./scripts/test.sh
```
