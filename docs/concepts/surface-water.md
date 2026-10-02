# Surface water (DWS)

Rain lands on the [terrain](terrain.md), runs downhill, collects in hollows and
leaves only by a physical route: over the edge of the district, into open
water, into the air, into the ground, or (with the drainage model) into the
drains. **Water never disappears on a timer.** A closed hollow keeps every drop
until something physical removes it.

| | |
|---|---|
| **Provides** | Water depth \( h \) and unit discharge \( \mathbf q \) on the [environment grid](terrain.md#the-environment-grid); the deepest and mean water under every road; an exact water ledger; Froude diagnostics |
| **Reads** | Terrain; the storms' rain field; the [DCM](solar.md)'s surface temperatures (evaporation); mapped green space (infiltration) and basins (open water) |
| **Feeds** | Road state and traffic ([vehicle dynamics](vehicle-dynamics.md)); the DCM's energy balance (evaporative cooling) |
| **Data class** | *Simulated* |
| **Runs** | Every 5 s of virtual time, in CFL-limited substeps |
| **Switch** | Module `hydrology`; with it off, roads fall back to the node flood model |
| **Code** | `shaders/include/dstns_hydrology.h` (the kernels), `src/environment/hydrology.cpp` (CPU), `src/vulkan/hydrology.cpp` and `shaders/hydro_*.comp` (Vulkan) |

## Governing equations

The 2D shallow-water equations in conservative form, with sources:

\[
\frac{\partial h}{\partial t} + \frac{\partial q_x}{\partial x} + \frac{\partial q_y}{\partial y} = R - I - D - E
\]
\[
\frac{\partial q_x}{\partial t} + \underbrace{\frac{\partial}{\partial x}\frac{q_x^2}{h} + \frac{\partial}{\partial y}\frac{q_x q_y}{h}}_{\text{convective acceleration}}
+ g h \frac{\partial (h + z_b)}{\partial x} = -g h S_{f,x}
\]

and likewise in \( y \), with Manning friction \( S_f = n^2\, \mathbf q\,|\mathbf q| / h^{10/3} \).

| Symbol | Meaning | Units |
|---|---|---|
| \( h \) | Water depth | m |
| \( \mathbf q = h\mathbf u \) | Unit discharge | m²/s |
| \( z_b \) | Terrain elevation | m |
| \( \eta = z_b + h \) | Water surface | m |
| \( R, I, D, E \) | Rain, infiltration, drainage, evaporation | m/s |
| \( n \) | Manning roughness, 0.016 s/m^1/3 (smooth asphalt and concrete) | s/m^1/3 |
| \( g \) | 9.81 | m/s² |

### The local-inertial approximation

DSTNS solves the **local-inertial** form (Bates, Horritt and Fewtrell 2010, as in
LISFLOOD-FP): the convective acceleration terms are dropped and friction is
treated semi-implicitly. On each cell face, with \( h_f = \max(\eta_l, \eta_r) - \max(z_l, z_r) \)
the depth that can flow,

\[
q^{t+\Delta t} = \frac{q_c - g\, h_f\, \Delta t\, \dfrac{\eta_r - \eta_l}{\Delta x}}{1 + g\, \Delta t\, n^2\, |q^t| / h_f^{7/3}},
\qquad
q_c = \theta q^t + \frac{1 - \theta}{2}\big(q^t_{-} + q^t_{+}\big),
\]

where \( q_c \) is de Almeida et al.'s (2012) weighted discharge, blending the
face with its two neighbours along the same direction (\( \theta = 0.8 \)). The
weighting adds the little numerical diffusion that stops the checkerboard
oscillation the unweighted scheme shows at low friction. Depths then follow
from continuity:

\[
h^{t+\Delta t}_{i,j} = h^t_{i,j} + \frac{\Delta t}{\Delta x}\Big(q_{x,i-\frac12} - q_{x,i+\frac12} + q_{y,j-\frac12} - q_{y,j+\frac12}\Big).
\]

The scheme is **well balanced**: a still pond over an uneven bed has a level
surface, no surface gradient and therefore no flow, exactly. It suits urban
pluvial flooding, which is subcritical almost everywhere. It does **not**
reproduce supercritical flow (Froude number above about 0.5; de Almeida and
Bates 2013); see [Limitations](#limitations).

## Numerics

**Fixed point.** The solver is integer arithmetic, written once in
`shaders/include/dstns_hydrology.h` and compiled as C++ and as GLSL, under the
same rules as the traffic step:

| Quantity | Format | Range | Resolution |
|---|---|---|---|
| Terrain \( z_b \) | Q16 m, signed 32-bit | ±32,768 m | 15 µm |
| Depth \( h \) | Q24 m, 32-bit | 0 to 128 m | 0.06 µm |
| Discharge \( q \) | Q20 m²/s, signed 32-bit | ±2,048 m²/s | 1 µm²/s |
| Products | 64-bit, formed as magnitudes so every shift is of a non-negative value | | |

\( h_f^{7/3} \) is computed as \( h^2 \cdot h^{1/3} \) with an integer cube root;
friction depth is capped at 30 m and flowing depth at 100 m, where friction is
negligible anyway, so no product overflows. Division of signed values is avoided
(GLSL leaves it undefined): magnitudes are divided and signs restored.

**Exact mass conservation.** A substep has four passes:

1. **Flux**: every face's new discharge, from the depths and the previous
   step's discharges.
2. **Limiter**: each cell's share \( \lambda = \min(1, h / \text{outflow}) \) of what is
   asked of it, so no cell can give more than it holds.
3. **Apply**: each face's transfer \( |q| \Delta t / \Delta x \), times its donor's
   limiter, is taken from one cell and given to the other, as one integer
   computed identically by both.
4. **Scale**: each discharge is scaled by its donor's limiter, so momentum
   agrees with the water that moved.

Water therefore changes only by what the sources add and remove and what
leaves the grid, and depths can never go negative, whatever the time step. The
**ledger** books every change, in integer depth units summed over cells:

\[
\text{stored}(t) = \text{stored}(0) + \text{rain} - \text{boundary} - \text{open water} - \text{evaporated} - \text{infiltrated} - \text{drained}.
\]

The conservation error reported is that identity's residual. In a correct build
it is **zero, exactly**, at every step; the tests check it after each one.

**Wet and dry.** A face carrying less than 0.1 mm of flowing depth passes
nothing. Thin films stay where they are until evaporation, infiltration or more
rain changes them.

**Time step and stability.** The step is 5 s (it divides the 900 s checkpoint
interval, so replay meets the same instants). It is split into \( N \) equal
substeps satisfying the CFL condition for the inertial scheme,

\[
\Delta t \le C\, \frac{\Delta x}{\sqrt{g\, h_\max}}, \qquad C = 0.7,
\]

using the deepest water of the previous step. \( N \) is capped at 64; a capped
step is flagged (`cfl_capped`). Even then depths cannot go negative (the
limiter) and mass is conserved; only accuracy suffers.

**Boundaries.** Every face on the district's edge sees a dry ghost cell at the
inner cell's ground level: water can leave downhill (a free outfall) but never
enter. Cells below `environment.sea_mask_m` (default −10 m, i.e. sea) and cells
under mapped basins and reservoirs (`landuse=basin|reservoir`) are **open
water**: what reaches them is booked as `open water` and removed.

**Dry fast path.** With no water anywhere and no rain, a step changes nothing,
so it is skipped. This is exact, not an approximation.

## Sources

**Rain.** Each storm cell's rain field, combined as for the road network,
\( 1 - \prod_k (1 - I_k W_k) \), scaled so a storm of intensity 1 rains 50 mm/h at its
centre (`rain_peak_mm_h`, a heavy convective cloudburst). Depth per step is
quantised to the depth unit with the remainder carried to the next step, so a
storm's total is exact. The observer's weather figure shows this rate.

**Evaporation.** A bulk aerodynamic formula on the DCM's surface temperature
\( T_s \) and the air temperature \( T_a \):

\[
E = \frac{\rho_a\, C_E\, u\, \big(q_\text{sat}(T_s) - RH\, q_\text{sat}(T_a)\big)}{\rho_w},
\qquad q_\text{sat}(T) = \frac{0.622\, e_s(T)}{p}, \quad e_s = 610.94\, e^{17.625\,T/(T + 243.04)} \;\text{Pa},
\]

with \( \rho_a = 1.2 \) kg/m³, \( C_E = 1.5\times10^{-3} \), \( u \) the local [wind](wind.md)
(3 m/s without the atmosphere module), and relative humidity 0.70 rising to 0.98 under
storm cloud. It is a potential: no more than is there is removed. Its latent
heat, \( L_v \rho_w E \) scaled by how wet the surface is (fully wet at 0.5 mm),
cools the surface in the [energy balance](solar.md#surface-energy-balance). On
hot asphalt a puddle loses about a millimetre an hour.

**Infiltration.** Cells under mapped parks, grass, woodland, pitches and
gardens infiltrate up to 10 mm/h; sealed surfaces nothing. Both are parameters.

**Drainage.** Booked as `drained`: what the [drain inlets](drainage.md) take, applied
exactly and before any other sink. Water a surcharged network returns to the
street comes back as a negative drain.

## Roads

After every step, each directed road's **deepest** and **mean** water over the
grid cells it crosses are recorded (cells sampled every half cell along its
geometry). The [vehicle model](vehicle-dynamics.md) turns them into speed,
capacity and closure, and into the flood index the road's state, flood events
and the observer's *Flooded* colour come from.

## Diagnostics: where the approximation is weakest

Once a minute, for every cell deeper than 5 cm, the Froude number
\( Fr = |\mathbf u| / \sqrt{g h} \) is evaluated. Cells above 0.5, where the
inertial approximation loses accuracy, are counted (`supercritical_cells`); those
that also change depth sharply to a neighbour (by more than half their depth)
are listed as **refinement candidates**, up to eight, strongest first. These are
where a hydraulic jump, a step or a constriction would call for a 3D or full
shallow-water treatment. DSTNS detects them; **no 3D solver is coupled**.

## Running on the GPU

The same kernels run on Vulkan as seven compute shaders (sources; flux, limiter,
apply and scale per substep; per-row tallies; per-road summaries), in one
submission per step. Depth and discharge stay on the device; the host reads
sixteen words per grid row and two per road, and the fields only for
checkpoints, overlays, the evaporation coupling (when water is stored) and the
once-a-minute diagnostics, which run on whole minutes on every backend so that
results never depend on it. A device failure raises the same recovery as the
traffic step: the engine restores its latest checkpoint and replays on the CPU.

**Bit-identical.** `dstns_hydrology_parity` compares the CPU and the device over
240 steps on two grids (fields, ledger, statistics, road summaries) and two
whole environment runtimes through a four-hour storm, surface temperatures
included; `dstns_engine_compute` compares whole simulations with the physics
and the water on each backend.

**When it is used.** Measured on an Apple M4 with water on every cell
(`dstns_benchmark hydrology`):

| Grid | CPU | Vulkan | |
|---|---|---|---|
| 64 × 64 | 0.74 ms | 0.74 ms | 1.0× |
| 128 × 128 | 2.86 ms | 0.90 ms | 3.2× |
| 256 × 256 | 14.85 ms | 1.53 ms | 9.7× |
| 512 × 512 | 72.3 ms | 4.43 ms | 16× |
| 1024 × 1024 | 203.6 ms | 6.79 ms | 30× |

A city's water is sparse, though: the CPU passes over dry faces return
immediately, while every device step pays about 0.8 ms to submit, wait and read
back. A full day on the bundled 11,664-cell district took 29 s on the CPU and
40 s with the water on the device. So `auto` uses the device from **131,072
cells** (about 360 × 360; `DSTNS_HYDROLOGY_GPU_MIN_CELLS` changes it), and
always when Vulkan is preferred; `cpu` never does.

## Outputs

| Where | What |
|---|---|
| `GET /api/v1/view/environment` → `state.hydrology` | Scheme, solver, substeps, water stored, deepest water, wet and flooded cells and area, peak rain, peak depth, peak flooded area, the ledger in m³, the conservation error (absolute and relative), parameters, Froude diagnostics and refinement candidates |
| `GET /api/v1/view/fields/water_depth` | Depth, m, to the millimetre |
| `GET /api/v1/view/road-environment` | Deepest and mean water per road |
| Observer | **Flood depth** field overlay; the **Surface water** card in the City tab with the ledger |

## Validation

`tests/environment/hydrology_tests.cpp` (CTest `dstns_hydrology`):

| Problem | Expectation | Result |
|---|---|---|
| Lake at rest: a pond at 2 m over an uneven bed, ten minutes | Not a single unit of depth changes; every discharge stays zero | Exact |
| Dam break: 1 m released onto a 1 mm film, frictionless, 2 m cells, 20 s | Monotone profile; drawdown reaching back into the reservoir; the front travels as a bore at \( \sqrt{g h} \) of the depth behind it | Front at 43 m, **34%** of Ritter's (1892) frictionless 125 m, as the inertial scheme must; depth at the dam 0.52 m against Ritter's 0.44 m |
| Water on a 3% slope | Runs downhill; leaves at the low edge; every cubic metre accounted for | |
| Basin: 30 min of 40 mm/h into a walled bowl, then an hour dry | Every drop still held; a level surface at the bottom; nothing drains or evaporates away by itself | Exact |
| Positivity: rough terrain, 200 mm/h, open water, sinks, steps far past the CFL limit | No cell ever negative; the ledger balances every step | Exact |
| Runtime, a storm over a valley | Water collects on the valley floor; roads there stand deeper than roads on the sides; the reported error is zero | |
| Replay through the engine | Rewinding and replaying reproduces the water and its field exactly | Exact |

On the bundled Berlin district, a seed's ordinary storms put 2,353 m³ of rain on
the ground over a day; an injected 50 mm/h cloudburst gives 10,100 m³ stored,
0.65 m at the deepest and 2.9 ha flooded deeper than 10 cm after 40 minutes,
gathered along the Spree valley, with a conservation error of zero.

## Limitations

- **Inertial, not full shallow water.** Convective acceleration is omitted:
  supercritical flow (Froude above about 0.5: steep streets, dam breaks,
  hydraulic jumps) is not represented faithfully, as the dam-break test shows.
  Such cells are flagged, not refined.
- **Resolution.** 25 m cells average away kerbs, gutters and building walls:
  water spreads across a street block rather than running along the gutter.
- **Rivers.** OpenStreetMap rivers usually come as multipolygon relations the
  map loader does not read, so a river valley fills like any hollow instead of
  carrying water away. Basins and reservoirs mapped as ways are open water.
- **Infiltration** is a constant capacity, with no soil moisture or Horton
  decay.
- **Rain** falls where its storm cell is; storms drift with the background
  wind, but rain is not blown sideways as it falls.
