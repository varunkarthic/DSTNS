# Performance

What DSTNS costs to run, how it scales, and how to measure it on your own
hardware.

## Measured figures

Release build, Apple silicon laptop (Apple Clang 21), October 2026:

| Operation | Size | Time |
|---|---|---|
| Scenario compilation | 15 × 15 grid, 225 nodes | 17 ms |
| Scenario compilation | 20 × 20 grid, 400 nodes, 1,520 edges | 26 ms |
| A* route | 15 × 15 grid, 2,500 queries | 3.95 µs per query |
| A* route | 20 × 20 grid, 1,000 queries | 6.1 µs per query |
| Snapshot (JSON) | 20 × 20 grid | 8.2 ms each |
| City download | Dar es Salaam, 42 MB | 20 to 60 s, network bound |
| District compile | 3,000 nodes from a 42 MB extract | A few seconds |

In Docker on the same machine, a 3,000-node district at 2× uses about 800 MB of
memory and 5 to 15% of one core.

These describe one machine on one day. Measure yours:

```bash
./build/dstns_perf_tests     # compilation and 2,500 routes; fails above 500 µs per route
./build/dstns_benchmark      # compilation, 1,000 routes, 100 snapshots
```

## Where the time and memory go

| Cost | Scales with | Notes |
|---|---|---|
| Physics, per virtual second | Nodes + edges | One pass over every node and edge; storms and surges add a term per active event |
| Real-time playback | Physics × base rate × speed | At 1× and a one-hour day, 24 virtual seconds per wall-clock second; at 5×, 120 |
| Checkpoints | (Nodes + edges) × 96 per day | Full dynamic state every 900 virtual seconds: the dominant memory cost |
| Seeking backwards | Up to 900 physics steps | Restore the nearest checkpoint, then replay |
| Snapshot | Edges | The observer polls one per second; compressed with gzip |
| Topology | Nodes + edges + places | Fetched once per run |

## Limits

| Limit | Value | Set by |
|---|---|---|
| Graph size | 50,000 nodes | `max_nodes` |
| District target | 3,000 nodes (200 to 50,000) | `map.district_nodes` |
| City extract | 5 km square (0.5 to 20 km) | `map.city_extent_m` |
| Downloaded extract | 200 MiB | `fetch_osm.py` (`MAX_BYTES`) |
| Speed | 5× | `kMaxTickRate` |

## Tuning

- **Faster interface on slow machines:** turn off the Vehicles and Buildings
  layers; choose a lower speed. Adaptive backpressure does this automatically
  when it must; see [Adaptive backpressure](../concepts/backpressure.md).
- **Less memory:** a smaller district (`map.district_nodes`), since checkpoint
  memory is proportional to it.
- **Faster first start:** keep the map cache (`--map-cache keep`), or pin a
  map.
- **Build type:** always use `-DCMAKE_BUILD_TYPE=Release` outside debugging;
  Debug builds are several times slower.
