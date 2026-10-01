# Performance

How much DSTNS costs to run, how that scales with the size of the district, and how
to measure it on your own hardware. Each figure is either measured (and says so,
with the machine) or derived from a formula stated beside it.

## Measured figures

Release build, Apple silicon laptop (Apple Clang 21), the bundled real district
(1,196 junctions, 2,554 directed edges, 34 km of road), October 2026.

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
./build/dstns_perf_tests     # compilation and 2,500 routes; fails above 500 microseconds per route
./build/dstns_benchmark      # compilation, 1,000 routes, 100 snapshots
```

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
cannot sustain 5x: the virtual clock then advances more slowly than requested, and
API requests wait behind each long step, since a step holds the engine lock. This is an extrapolation from one measurement, not a benchmark:
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
