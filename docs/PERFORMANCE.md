# Performance & Scalability Benchmark

The `dstns_performance_smoke` target uses a deterministic 15x15 synthetic grid and 2,500 A* queries. It requires all 2,500 routes to resolve and fails when mean query latency exceeds 500 microseconds. The ceiling is intentionally much looser than typical local performance so it catches major algorithmic regressions without treating a heterogeneous CI runner as a precision benchmark.

Sample local Release run on 2026-09-07:

- **Scenario compilation**: 225 nodes in 15 ms.
- **A\* strategic routing**: 2,500/2,500 routes in 9,066 microseconds, or 3.6264 microseconds/query.

These measurements describe one run, not a portable guarantee. Run `./build/dstns_perf_tests` on the target system for current evidence.
