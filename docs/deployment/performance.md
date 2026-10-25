# Performance

How much DSTNS costs to run, how that scales with the size of the district, and how
to measure it on your own hardware. Each figure is either measured (and says so,
with the machine) or derived from a formula stated beside it.

## Measured figures

Release build, Apple silicon laptop (Apple Clang 21), the bundled real district
(1,196 junctions, 2,554 directed edges, 34 km of road).

| Operation | Result |
|---|---|
| Physics, whole day | 86,400 virtual seconds in 23.6 s of wall time |
| Physics rate | **3,656** virtual seconds per wall second, **0.27 ms** per virtual second |
| Worst-case backward seek (899 s replay) | 0.31 s |
| Forward seek of 60 s | 0.018 s |
| Snapshot request, uncompressed JSON | 66 ms, 5.0 MB |
| Snapshot request, gzip | 273 KB (18 times smaller) |
| Topology request | 134 ms, 5.4 MB, fetched once per run |
| A* route, 15 x 15 grid | 3.95 microseconds per query |
| Scenario compile, 20 x 20 grid | 26 ms |
| City download (Dar es Salaam, 42 MB) | 20 to 60 s, network bound |

In Docker on the same machine, a 3,000-node district at 2x used about 800 MB of
memory and 5 to 15% of one core.

These describe one machine on one day. Measure yours:

```bash
./build/dstns_perf_tests             # compilation and 2,500 routes; fails above 500 microseconds per route
./build/dstns_benchmark --quick      # the load benchmark below, in about a minute and a half
./build/dstns_benchmark --narrator fm --json benchmark.json   # everything, with the on-device model
```

## Under load

`dstns_benchmark` (see [Command-line tools](../reference/command-line-tools.md#dstns_benchmark))
drives the engine along four axes. Release build, Apple M4 (4 performance and 6
efficiency cores), synthetic grids with a fixed seed. "Ticks/s" is virtual
seconds simulated per wall second; the fastest playback, a 60-second day, needs
1,440 and the default one-hour day 24.

### District size

| Grid | Junctions | Edges | Compile | Tick | Ticks/s | Backward seek | Snapshot build | Snapshot JSON | Snapshot | Topology built | Topology cached | A* route |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 x 10 | 100 | 360 | 6 ms | 11 µs | 88,942 | 7 ms | 1.8 ms | 0.7 ms | 0.15 MiB | 3.2 ms | 0.01 ms | 1.6 µs |
| 25 x 25 | 625 | 2,400 | 39 ms | 91 µs | 10,931 | 56 ms | 9.5 ms | 4.8 ms | 0.96 MiB | 21 ms | 0.04 ms | 30 µs |
| 50 x 50 | 2,500 | 9,800 | 185 ms | 390 µs | 2,562 | 234 ms | 29 ms | 20 ms | 3.9 MiB | 87 ms | 0.12 ms | 122 µs |
| 75 x 75 | 5,625 | 22,200 | 515 ms | 889 µs | 1,125 | 535 ms | 30 ms | 44 ms | 8.9 MiB | 197 ms | 0.43 ms | 321 µs |
| 100 x 100 | 10,000 | 39,600 | 1.1 s | 1.68 ms | 597 | 1.0 s | 50 ms | 80 ms | 16 MiB | 353 ms | 0.86 ms | 586 µs |

The tick is linear in the edges (about 40 ns per edge per virtual second). Every
size runs the default one-hour day with room to spare (25 times over at 100 x
100); the fastest playback holds up to about 4,000 junctions.

### Storms and incidents

At 50 x 50, from 08:00:

| Storms a day | Incidents a day | Tick | Ticks/s | News items |
|---|---|---|---|---|
| 0 | 4 | 401 µs | 2,496 | 4,487 |
| 12 | 16 | 409 µs | 2,446 | 4,702 |
| 48 | 128 | 445 µs | 2,245 | 5,218 |
| 96 | 256 | 473 µs | 2,115 | 5,946 |

A storm costs one pass over the junctions per tick and an incident one edge, so
even a day with 96 storms and 256 incidents is 18% slower than a dry one.

### Observers

At 50 x 50 at the fastest playback (1,440 virtual seconds a second), with
observers fetching and serializing a snapshot as the browser does:

| Observers | Polling | Clock keeps up | Snapshot p50 | Snapshot p95 |
|---|---|---|---|---|
| 0 | - | 101% | - | - |
| 1 | once a second | 101% | 61 ms | 277 ms |
| 8 | once a second | 101% | 50 ms | 67 ms |
| 32 | once a second | 85% | 99 ms | 153 ms |
| 2 | continuously | 96% | 75 ms | 120 ms |
| 8 | continuously | 30% | 147 ms | 226 ms |

Eight observers cost the clock nothing, and 32 still hold it at 85% of the
fastest playback. Clients polling flat out are a stress, not an audience: they
win the engine lock often enough to slow the clock, which is what [Adaptive
backpressure](../concepts/backpressure.md) exists to prevent.

### Narration

The cost on the simulation thread is building an item's facts (5 µs for an
incident) and a hash lookup (0.1 µs); the model itself runs on two worker
threads. Apple's on-device Foundation Model, through `fm serve` on the M4,
accepted 24 of 24 narrations at 2.7 s mean and 4.3 s worst latency. One world's
72 incidents and storms take a single worker 21.6 s against a model answering in
250 ms, and four workers 5.5 s. From the persistent cache, after a restart, they
take 0.03 ms. See [Natural-language narration](../guide/narration.md).

## What makes it fast

**Caches, in process.** The topology response, which never changes during a
world, is serialized once and served from memory (0.12 ms instead of 87 ms at
50 x 50); narrations are kept by the hash of their facts in memory and in
SQLite. Both live in the server process rather than in Redis or memcached:
DSTNS is a single process with one engine, so an external cache would add a
network hop and a service to deploy without adding a reader, and SQLite was
already a dependency.

**Short lock holds.** A snapshot copies the dynamic arrays under the engine lock
(a memcpy, under a millisecond) and builds its JSON afterwards, in parallel
slices on several cores for networks above 8,192 edges. The playback loop catches
up in slices of about 20 ms and releases the lock between them, so a snapshot,
a pause or a seek waits for one slice rather than the whole catch-up.

**Less per tick.** Storms and surges are shaped once per tick instead of once
per junction or edge; each edge's signal group and traversable direction are
fixed when the world is installed; the hot loops index the state arrays
directly. Against the same benchmark before these changes, a 50 x 50 tick went
from 499 µs to 390 µs and a backward seek from 289 ms to 234 ms, with results
bit-identical.

**Apple silicon.** The physics clock runs at interactive quality of service, so
macOS keeps it on the performance cores; narration runs at utility and drifts to
the efficiency cores, where it never competes with the physics. Apple clang
already targets the M1 baseline every Apple silicon Mac shares; configure with
`-DDSTNS_TUNE_FOR_HOST=ON` to tune for the build machine's own CPU instead.
None of this is specific to one platform's results: Linux and Intel builds run
the same code, without the QoS hints.

## Cost model

### Physics

Each virtual second does one pass over every node and every legal edge, plus a term
for each active storm and surge. With \( N \) nodes, \( E \) edges, \( S \) active
storms and \( Z \) active surges, the cost per virtual second is

\[
T_{\text{step}} \;\approx\; \underbrace{c_N\,N\,S}_{\text{rain at nodes}} \;+\; \underbrace{c_E\,E}_{\text{edge dynamics}} \;+\; \underbrace{c_Z\,E\,Z}_{\text{surge coverage}}
\]

The edge term dominates in practice, so cost is close to linear in \( E \). The measured
0.27 ms for \( E = 2{,}554 \) is about 100 ns per edge per second, which gives a rough
planning rule of \( T_{\text{step}} \approx 0.1\ \mu\text{s} \times E \).

### Real-time headroom

At base rate \( r_0 = 86400 / T_P \) virtual seconds per wall second and tick rate
\( k \), the engine must simulate \( r_0 k \) steps each wall second. The fraction of
one core that takes is

\[
u \;=\; \frac{r_0\, k\, T_{\text{step}}}{1\ \text{s}}
\]

For the default one-hour day (\( r_0 = 24 \)) on the bundled district
(\( T_{\text{step}} = 0.27 \) ms):

| Speed \( k \) | Steps per wall second | Core used \( u \) |
|---|---|---|
| 1x | 24 | 0.65% |
| 3x | 72 | 1.9% |
| 5x | 120 | 3.2% |

At this size the engine runs far faster than real time, and the limit on useful
speed is the observer's ability to draw, not the core.

**Extrapolation to the largest district.** A 50,000-node district has about
\( 2.1 \times 50{,}000 \approx 107{,}000 \) edges, 42 times the bundled one, so by the
linear model \( u \) is 42 times larger: about 27% of a core at 1x, 80% at 3x, and
**135% at 5x**. The physics loop runs on a single thread, so a district that large
cannot sustain 5x: the virtual clock then advances more slowly than requested.
API requests wait at most one 20 ms catch-up slice for the engine lock. This is an extrapolation from one measurement, not a benchmark:
measure your own district with the commands above.

!!! note "What bounds the observer"
    Each snapshot is 5 MB uncompressed on this district, and the observer parses it
    every second. That, not the physics, is what slows a browser first, and it is
    what [Adaptive backpressure](../concepts/backpressure.md) measures and corrects.

### Seeking

A backward seek restores the latest checkpoint at or before the target and replays
at most 899 steps:

\[
T_{\text{seek}} \;\le\; 899\, T_{\text{step}} \;=\; 899 \times 0.27\ \text{ms} \;\approx\; 0.24\ \text{s}
\]

The measured worst case is 0.31 s, in line with this (the restore itself copies the
checkpoint). A forward seek of \( \Delta \) seconds costs \( \Delta\, T_{\text{step}} \).

## Memory

A checkpoint is taken every 900 virtual seconds, so a full day holds

\[
n_{\text{cp}} = \frac{86400}{900} = 96
\]

checkpoints. Each copies the dynamic arrays and the event runtime. The arrays alone
are

\[
B_{\text{arrays}} = 32\,N + 184\,E \ \text{bytes}
\]

(`NodeDynamic` is 32 bytes and `EdgeDynamic` 184). For the bundled district that is
0.49 MiB, so the arrays alone would cost \( 96 \times 0.49 \approx 47 \) MiB.

**Measured:** the process grew from 119 MiB at 00:00 to 334 MiB after running to the
end of the day, a difference of 215 MiB over 95 additional checkpoints, or
**2.3 MiB per checkpoint**, roughly 4.7 times the raw arrays. The remainder is the
event runtime's per-place demand state and its bounded history, which are copied with
each checkpoint.

\[
M_{\text{run}} \;\approx\; M_{\text{base}} \;+\; n_{\text{cp}} \cdot \beta \cdot \big(32N + 184E\big), \qquad \beta \approx 4.7
\]

where \( M_{\text{base}} \) is the loaded scenario, graph and journal. The 3,000-node
Dar es Salaam district has arrays of 1.17 MiB, so \( \beta \) predicts about
\( 96 \times 4.7 \times 1.17 \approx 530 \) MiB of checkpoints on top of the base, in
line with the roughly 800 MB observed in Docker.

!!! tip "Reducing memory"
    Memory scales with district size, so a smaller `map.district_nodes` is the lever.
    Checkpoint spacing (900 s) is fixed; a coarser spacing would trade memory for
    longer worst-case seeks.

## Limits

| Limit | Value | Set by |
|---|---|---|
| Graph size | 50,000 nodes | `max_nodes` |
| District target | 3,000 nodes (200 to 50,000) | `map.district_nodes` |
| City extract | 5 km square (0.5 to 20 km) | `map.city_extent_m` |
| Downloaded extract | 200 MiB | `fetch_osm.py` (`MAX_BYTES`) |
| Speed | 5x | `kMaxTickRate` |

## Tuning

- **A faster interface on slow machines:** turn off the Vehicles and Buildings
  layers and choose a lower speed. Adaptive backpressure does this automatically
  when it must.
- **Less memory:** a smaller district.
- **Faster first start:** keep the map cache (`--map-cache keep`) or pin a map.
- **Build type:** use `-DCMAKE_BUILD_TYPE=Release` outside debugging; a Debug build
  is several times slower.
