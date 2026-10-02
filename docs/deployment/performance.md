# Performance

How much DSTNS costs to run, how that scales with the size of the district, and how
to measure it on your own hardware. Each figure is either measured (and says so,
with the machine) or derived from a formula stated beside it.

## Measured figures

Release build, Apple silicon laptop (Apple Clang 21), the bundled real district
(1,196 junctions, 2,554 directed edges, 34 km of road).

| Operation | Result |
|---|---|
| Physics, whole day (CPU backend, engine 2.2.0) | 86,400 virtual seconds in 24.8 s of wall time (2.1.0: 23.6 s) |
| Physics rate | **3,489** virtual seconds per wall second, **0.29 ms** per virtual second |
| The same day forced onto the GPU (Vulkan, MoltenVK) | 79.1 s, 0.92 ms per virtual second: a world this size belongs on the CPU, which is what `auto` chooses |
| Worst-case backward seek (899 s replay), late evening | 0.07 s (2.1.0, midday: 0.31 s) |
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
./build/dstns_benchmark compute [--sizes 1000,50000] [--day] [--json report.json]
                             # the physics step on each backend, by world size
```

## Compute backends

`dstns_benchmark compute` times the physics step on synthetic road grids
from 1,000 to 1,000,000 junctions, on the CPU backend with one thread and
with all of them (up to eight), and on Vulkan. Each step is driven like the
engine's: every signal phase, a tenth of the edges' demand couplings, three
storms and a surge. Measured on an Apple M4 (10 cores; GPU through MoltenVK
1.4.2), engine 2.2.0. Step times are medians. Whole-loop times vary by about
30% between runs on this machine, because the GPU's clock follows its load.

| Junctions | Directed edges | CPU, 1 thread | CPU, 8 threads | Vulkan | GPU time in the step | Vulkan vs faster CPU |
|---|---|---|---|---|---|---|
| 1,000 | 3,872 | 0.12 ms | 0.12 ms | 0.57 ms | — | 0.22× |
| 3,000 | 11,780 | 0.34 ms | 0.34 ms | 0.82 ms | — | 0.41× |
| 10,000 | 39,600 | 1.16 ms | 0.32 ms | 1.0–2.7 ms | 0.6–0.8 ms | 0.12–0.32× |
| 50,000 | 199,104 | 8.19 ms | 1.79 ms | 1.49 ms | 0.83 ms | **1.21×** |
| 100,000 | 398,734 | 13.4 ms | 3.02 ms | 3.11 ms | 1.77 ms | 0.97× |
| 500,000 | 1,997,170 | 68.5 ms | 24.5 ms | 15.9 ms | 15.3 ms | **1.54×** |
| 1,000,000 | 3,996,000 | 131 ms | 52.7 ms | 40.0 ms | 27.4 ms | **1.32×** |

| Also measured | Result |
|---|---|
| Accelerator bring-up (instance, device, pipelines, self-test) | 491 ms with an empty pipeline cache, 11 ms with a warm one |
| Per-step transfer, 1,000,000 junctions | 3.0 MiB up (changed inputs only), 46 MiB down (three edge fields) |
| Full state readback, 1,000,000 junctions | 72 ms |
| 900-step seek replay, 1,000,000 junctions | 46.3 s on Vulkan, 51.2 s on eight CPU threads, 121 s on one |

What this shows:

- **A fixed cost per step.** A Vulkan step costs about half a millisecond
  before any work: one submission, one wait, one readback. Every simulated
  second must return to the host (events and demand couplings read the
  step's results), so the cost cannot be amortised across steps.
  District-sized worlds therefore stay on the CPU.
- **A modest win at scale.** From about 50,000 junctions the GPU is
  faster, by 1.2 to 1.5 times over eight CPU threads on this machine. A
  discrete GPU, with more arithmetic and memory bandwidth than an integrated
  one, would gain more; the same step code runs on it unchanged.
- **Integer arithmetic has a price.** The step is 64-bit integer fixed point
  (the reason it is identical on every device), and GPUs emulate 64-bit
  integer multiplication and division. Two variations were measured and
  rejected: a float-steered exact division (30% slower on the GPU) and other
  workgroup sizes (64 and 256: no difference).

Hence `auto`'s thresholds: below 40,000 junctions *and* 150,000 edges the CPU is
used without measuring; above either, both backends are timed on the world
itself and the faster by at least 10% is kept.

### Where GPUs pay: batched field kernels

The structured-grid field solver keeps its data on the device and runs many
iterations in one submission, the shape of the terrain-water and atmospheric
models DSTNS is built to add. 300 diffusion iterations on a 512 × 512 grid
(`dstns_field_tests`, same machine):

| Backend | Time |
|---|---|
| CPU, one thread | 110 ms |
| Vulkan, MoltenVK | 20 ms (5.5×) |
| Vulkan, Mesa KosmicKrisp | 27 ms (4.1×) |

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

checkpoints. Each copies the fixed-point physics state and the event runtime. The
state alone is

\[
B_{\text{state}} = 8\,N + 68\,E \ \text{bytes}
\]

(two 32-bit words per node and seventeen per edge; before 2.2.0 checkpoints held the
double-precision `NodeDynamic` and `EdgeDynamic`, 32 and 184 bytes). For the bundled
district that is 0.18 MiB.

**Measured (2.2.0):** the process grew from 84 MiB at 00:00 to 278 MiB after running
to the end of the day, 194 MiB over 95 additional checkpoints, or **2.0 MiB per
checkpoint** (2.1.0: 2.3 MiB). Most of it is the event runtime's per-place demand
state and its bounded history, copied with each checkpoint:

\[
M_{\text{run}} \;\approx\; M_{\text{base}} \;+\; n_{\text{cp}} \cdot \big(8N + 68E + R\big)
\]

where \( M_{\text{base}} \) is the loaded scenario, graph and journal, and \( R \),
about 1.9 MiB for this district, is the event runtime. A Vulkan backend adds, on the
device, the static tables (\( 16N + 56E \)), the inputs (\( 4N + 28E \)), two copies
of the state (\( 2 \times (8N + 68E) \)) and a staging copy (\( 8N + 68E \)): about
\( 44N + 288E \) bytes, roughly 300 MB for a million-edge world. It is checked against
the device's memory budget before anything is allocated, and freed when the world is
replaced.

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
