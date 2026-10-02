# Drainage (DDS)

Where the water that reaches a drain goes. Before this module, a drain was a
hole: water entering it simply disappeared. Now it enters a pipe network with a
finite capacity, travels downstream, and leaves at an outfall, or backs up and
returns to the street:

> rain → street water → inlets → pipes → outfall, or → surcharge → backflow
> onto the street.

| | |
|---|---|
| **Provides** | A drainage network (inlets, manholes, pipes, outfalls); flow and fill in every pipe; surcharged manholes; volumes drained, discharged and returned |
| **Reads** | Street water depth ([surface water](surface-water.md)); ground elevation ([terrain](terrain.md)); the street network; open water |
| **Feeds** | Surface water, through an exact exchange of volume each surface step |
| **Switches** | Module `dds` (default on); needs `hydrology` |
| **Code** | `src/environment/drainage.cpp`, `EnvironmentRuntime::update_hydrology` in `src/environment/runtime.cpp` |

## A synthetic network, and saying so

No city DSTNS can load publishes its sewers. The network is therefore
**synthetic**: a deterministic approximation built from the street network and
the terrain by ordinary design rules. It is never presented as the city's real
drainage: the summary's `source` is `synthetic`, its `data_class` says *"a
deterministic approximation, not the city's sewers"*, the observer's layer is
called **Drains (synthetic)** and its card says the same. It depends on nothing
but the scenario, so a seed always builds the same network.

## Building the network

**Manholes.** One under every junction, at its ground elevation.

**Outfalls.** Junctions on cells of mapped open water; then the lowest junctions
within a band of the district's edge (6% of its extent, at least 150 m), at
least 400 m apart, up to `max_outfalls` (8). A junction that no street joins to
an outfall becomes one itself.

**Layout.** A shortest-path forest from the outfalls along the streets, so that
every junction drains through exactly one pipe and the pipes follow streets.
Gravity sewers follow the land, so a step whose far end is *higher* than its
near end (water would have to climb towards the outfall) costs 50 m of extra
pipe for every metre of rise. Ties break by id, so the forest is deterministic.

**Inverts.** From the leaves downstream, each manhole's invert lies at least
`min_cover_m` (1.2 m) below its street, and below every pipe arriving from
upstream by at least the minimum fall (`min_slope`, 0.3%), so every pipe drains
by gravity. Where the land will not let a pipe fall, the network deepens.

**Catchments.** Each grid cell drains to its nearest junction; a pipe's
catchment is everything upstream of it.

**Sizing.** Each pipe is the smallest standard diameter (0.30 m to 2.40 m)
whose full-bore Manning capacity at its slope carries the design storm from its
whole catchment by the rational method,

\[
Q_\text{design} = C\, i\, A, \qquad
Q_\text{full} = \frac{1}{n}\, A_p\, R^{2/3} \sqrt{S}, \quad A_p = \frac{\pi D^2}{4},\; R = \frac{D}{4},
\]

with runoff coefficient \( C \) = 0.85 (sealed urban surfaces), design intensity
\( i \) = 25 mm/h (`design_rain_mm_h`, roughly a two-year storm in many cities)
and Manning's \( n \) = 0.013 (concrete). Then, from the leaves down, no pipe is
smaller than any pipe feeding it, the design rule that keeps a trunk from
choking where it steepens. A storm heavier than the design storm overloads it.

**Inlets.** A grate every `inlet_spacing_m` (50 m) on each kerb of every street,
in the grid cells the street crosses, each draining to the nearer junction.

On the bundled Berlin district this gives 1,188 pipes (30.2 km), 1,865 inlet
cells and 8 outfalls.

## Hydraulics

A node-link model. Each manhole stores water: its shaft, and half of every pipe
it joins. While the pipes fill, its plan area is their volume over their depth
plus the shaft; once they are full, the shaft alone, so the head rises quickly
up to the street and beyond (**surcharge**).

**Inlet capture.** A grate passes water as a weir in shallow water and as an
orifice once submerged, whichever passes less (HEC-22):

\[
Q_\text{weir} = C_w\, P\, d^{3/2}, \qquad Q_\text{orifice} = C_o\, A_g \sqrt{2 g d},
\]

with \( C_w \) = 1.66 m^½/s, \( C_o \) = 0.67, a 600 × 400 mm grate
(\( A_g \) = 0.24 m², \( P \) = 2 m), and \( d \) the water surface above the
greater of the street and the manhole's head. Four times the depth gives eight
times the flow while it is a weir.

**Backflow.** A manhole whose head stands above the street water lifts water
back out through its grates by the orifice relation on the difference, never
more than it holds above the street.

**Pipe flow.** Each pipe carries Manning flow driven by the difference in
hydraulic head between its ends, scaled by how full it is:

\[
Q = K\, f^2 \sqrt{\frac{|H_a - H_b|}{L}}, \qquad K = \frac{A_p R^{2/3}}{n}, \quad f = \min\!\Big(1, \frac{\max(H_a - z_a,\, H_b - z_b)}{D}\Big),
\]

limited so that it never overshoots the head it equalises, and so that no
manhole gives more than it holds. Flow can run backwards when a downstream
manhole stands higher. An outfall is free: its head is its invert, and what
reaches it leaves the district. One-second substeps within each 5 s surface
step.

A full Saint-Venant pipe solver could replace the routing behind the same
interface; the street side would not change.

## Exact coupling

Volumes are integers in the surface model's own unit (Q24 metres of depth on
one grid cell), so water moves between street and pipe without rounding:

1. before each surface step, the inlets take their share of the street water
   from the depths the solver holds, never more than a cell holds;
2. the surface step applies those amounts as its first sink (`drained` in its
   ledger), before evaporation and infiltration;
3. the network credits each manhole with exactly what its inlets took (or
   returned), then routes.

Two ledgers, each exact at every step:

\[
\text{drained} = \text{stored in the pipes} + \text{discharged at outfalls} + \text{returned to the street},
\]

\[
\text{rain} = \text{on the streets} + \text{in the drains} + \text{discharged} + \text{left at the edge} + \text{evaporated} + \text{infiltrated}.
\]

Both conservation errors are reported, and are zero.

The street depths are read on the host; with the surface model on a Vulkan
device the depths are fetched for the exchange, and the device applies the same
integer amounts, so results do not depend on the backend.

## Events

When the first manhole surcharges the engine records `dds.surcharge` in the
system log and a **Drains overloaded** news item (`DRAIN_SURCHARGE`, category
*flooding*). The water it returns to the street floods roads through the
ordinary [road state](vehicle-dynamics.md#water-on-the-road).

## Outputs

| Where | What |
|---|---|
| `GET /api/v1/view/drainage` | Every pipe (`from` and `to` junction, `diameter_m`, `slope`, `length_m`, `capacity_m3_s`, `flow_m3_s`, `utilisation`), the outfall junctions, the surcharged junctions, the `summary`, and whether the module is `enabled` |
| `GET /api/v1/view/environment` → `state.drainage` | The summary: source, inlets, junctions, pipes, outfalls, length, design storm, volumes stored, drained, returned and discharged, conservation error, surcharged manholes, full pipes, peak utilisation |
| `state.water_system` | The whole water budget: on the streets, in the drains, discharged, and the combined error |
| Observer | Layer **Drains (synthetic)**: pipes dashed over their streets, wider for larger pipes, brighter as they fill, red beyond full-bore capacity, a red ring on each surcharged manhole. The **Drainage** card in the City tab |

## Validation

`tests/environment/drainage_tests.cpp` (CTest `dstns_drainage`):

- **the network**: a manhole at every junction; a grate every 50 m on each
  kerb; every junction drains through exactly one pipe and outfalls through
  none; every pipe at least the minimum cover below the street, falling by at
  least the minimum slope, of a standard diameter, never narrowing downstream;
  from every junction the pipes lead to an outfall;
- **inlets**: weir scaling (four times the depth, eight times the flow); the
  orifice limit in deep water; nothing from a dry street; never more than the
  street holds; a surcharged network backflows;
- **scenario B**, 30 minutes of uniform rain on a 1% slope, then an hour dry:

| Storm | Into the drains | Discharged | Returned | On the street | Peak utilisation | Surcharged |
|---|---|---|---|---|---|---|
| 15 mm/h, pipes for 25 mm/h | 5,911 m³ | 5,416 m³ | 0 | 10,272 m³ | 0.33 | 0 |
| 60 mm/h, pipes for 25 mm/h | 26,707 m³ | 26,118 m³ | 0 | 13,313 m³ | 0.95 | 0 |
| 60 mm/h, pipes for 3 mm/h | 18,568 m³ | 17,989 m³ | 184 m³ | 13,367 m³ | 2.14 | 18 |
| 60 mm/h, no drains | 0 | 0 | 0 | 16,257 m³ | | |

  Street and pipes balance exactly at every step of every run. Below the
  design storm no pipe fills; an undersized network surcharges, water backs out
  of its inlets and more stays on the street; drains always take a share; no
  outfall discharges more than fell.

With 60 mm/h on adequately sized pipes nothing surcharges: the grates, not the
pipes, are the bottleneck, as they often are in practice.

## Limitations

- **Synthetic.** Layout, depths and sizes come from design rules, not records:
  the network is plausible, not the city's. Combined and separate sewers are
  not distinguished; there are no pumps, weirs, storage tanks or culverts.
- **Node-link routing**, not Saint-Venant: no pressurised wave speed, no
  hydraulic jumps; the pipe's fill is taken from the deeper end.
- **Grates** are spaced uniformly and never block with debris.
- **Outfalls** are free: a river or sea level does not back up into them.
- The network is built at 25 m resolution: a grate drains the whole cell it
  sits in.
