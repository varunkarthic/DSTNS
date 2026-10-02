# Urban wind (DAS)

The near-surface wind over the district: the wind above the city, slowed and
steered by its buildings, lifted by its terrain and stirred by the Sun's
heating of its streets.

| | |
|---|---|
| **Provides** | The wind at 10 m over every grid cell; each road's headwind; gusts under storm cells; the steering wind for storms |
| **Reads** | Building footprints and heights (OpenStreetMap); elevation ([terrain](terrain.md)); surface temperature ([DCM](solar.md)); storm cells |
| **Feeds** | Vehicle drag ([vehicle dynamics](vehicle-dynamics.md)); convection in the surface energy balance; evaporation ([surface water](surface-water.md)); where storms drift ([weather](weather.md)) |
| **Switches** | Module `das` (default on) |
| **Code** | `src/environment/atmosphere.cpp`; `EnvironmentRuntime::update_wind` in `src/environment/runtime.cpp` |

## The urban canopy

Every mapped building footprint (a closed way tagged `building`, other than
`building=no`) is rasterised onto a 5 m sub-grid of the environment grid, so a
building smaller than a cell still counts for the share it covers. Each grid
cell gets a **plan area fraction** \( \lambda_p \) (built area over cell area)
and the footprint-weighted **mean height** of what is built on it.

Heights come from, in order:

| Source | Rule | Counted as |
|---|---|---|
| `height` | Metres; feet when written with `'` or `ft` | Mapped |
| `building:levels` | Storeys × 3 m | Mapped |
| Otherwise, by `building=` | Garage, shed, kiosk, carport, roof: 3.5 m; house, detached, terrace, farm: 7 m; anything else: 12 m (four storeys) | Estimated |

The summary reports how many heights were mapped and how many estimated. In the
bundled Berlin district 630 of 1,165 buildings have a mapped height (25 from
`height`, 605 from `building:levels`) and 535 are estimated; mean height 15 m,
built fraction 10%.

## The wind above the city

The background wind is the wind at 10 m over open ground, before the city
changes it. Its climate comes from the planetary wind belts (e.g. Wallace and
Hobbs, *Atmospheric Science*, ch. 7):

| Latitude | Belt | Prevailing from (N / S hemisphere) | Mean speed |
|---|---|---|---|
| below 8° | Doldrums | Any (drawn from the seed) | 2.5 m/s |
| 8° – 30° | Trades | 60° / 120° | 4.5 m/s |
| 30° – 60° | Westerlies | 250° / 290° | 4.2 m/s |
| beyond 60° | Polar easterlies | 80° / 100° | 4.0 m/s |

Winter is windier (× 1.15) and summer calmer (× 0.9). The run's own day departs
from that, from its atmosphere stream (`seed.derive("das.wind")`): the
prevailing direction by \( 35° \times N(0,1) \), the speed by a factor
\( \exp(0.3\,N(0,1)) \) held within 0.5 to 1.8, and a slow swing in direction
of 10° to 25° with its own phase. Through the day,

\[
U(t) = \bar U \Big(1 + 0.25 \cos \frac{2\pi (t - 14)}{24}\Big), \qquad
\theta(t) = \theta_0 + \Delta\theta \sin \frac{2\pi (t - t_\theta)}{24},
\]

with \( t \) the solar hour: daytime convection mixes faster air down, so the
surface wind peaks in mid-afternoon and is lightest before dawn.

## The flow model

A three-dimensional **lattice Boltzmann** model, D3Q19, over the district. Each
lattice cell holds 19 particle distributions \( f_i \) moving with velocities
\( \mathbf c_i \) (rest, six faces, twelve edges); density and velocity are
their moments, \( \rho = \sum_i f_i \), \( \rho\mathbf u = \sum_i \mathbf c_i f_i \).
Each step, every cell collides towards the local equilibrium and streams to its
neighbours:

\[
f_i(\mathbf x + \mathbf c_i, t + 1) = f_i - \frac{1}{\tau}\big(f_i - f_i^\text{eq}\big) + \Delta f_i,
\qquad
f_i^\text{eq} = w_i \rho \Big(1 + 3\, \mathbf c_i\cdot\mathbf u + \tfrac92 (\mathbf c_i\cdot\mathbf u)^2 - \tfrac32 u^2\Big),
\]

which recovers the weakly compressible Navier–Stokes equations with viscosity
\( \nu = (\tau - \tfrac12)/3 \) in lattice units.

**Turbulence.** A Smagorinsky large-eddy closure adds an eddy viscosity from
the local strain, computed from the non-equilibrium momentum flux
\( \Pi_{\alpha\beta} = \sum_i c_{i\alpha} c_{i\beta} (f_i - f_i^\text{eq}) \)
(Hou et al. 1996):

\[
\tau = \tfrac12 \Big(\tau_0 + \sqrt{\tau_0^2 + 18\sqrt2\, C_s^2\, |\Pi| / \rho}\Big), \qquad \tau_0 = 0.52,\; C_s = 0.16.
\]

**Forces** enter by the exact difference method (Kupershtokh 2004),
\( \Delta f_i = f_i^\text{eq}(\rho, \mathbf u + \Delta\mathbf u) - f_i^\text{eq}(\rho, \mathbf u) \):

- *Buildings* as a distributed (porous canopy) drag,
  \( \mathbf F = -\tfrac12 C_d\, a\, |\mathbf u|\, \mathbf u \), with \( C_d \) = 1.2
  (Coceal and Belcher 2004) and frontal area density \( a = \lambda_p / b \) for
  buildings of width \( b \) = 15 m, over the part of each layer the buildings fill.
- *The ground* as the log law's wall drag in the first fluid layer,
  \( C_D = \big(\kappa / \ln(z_1/z_0)\big)^2 \), \( \kappa \) = 0.41, \( z_0 \) = 0.03 m.
- *Heat* as a Boussinesq buoyancy, \( a_z = g\, \Delta T' / T \times e^{-z/100\,\text{m}} \),
  where \( \Delta T' \) is the street's surface-minus-air temperature relative to
  the district's mean: warmer streets push air up, cooler ones let it settle.

Drag is applied implicitly, \( \mathbf u' = (\mathbf u + \mathbf a)/(1 + k|\mathbf u|) \),
which is stable however dense the canopy.

**Boundaries.**

- The open sides and top are held at a logarithmic boundary-layer profile
  \( u(z) \propto \ln\big((z + z_0)/z_0\big) \) over the district's mean roughness,
  in the direction the wind blows to, with a four-cell sponge relaxing towards it
  so waves leave without reflecting. The same condition serves inflow and outflow,
  whatever the wind's direction.
- The ground reflects specularly (free slip); the log-law drag supplies its friction.
- Terrain is solid cells, rounded to whole layers; steps bounce back.

**The lattice** is laid over the environment grid with cubic cells: as many
grid cells to a lattice cell as keep the longer side within 64 cells, and
enough layers to reach 250 m (and three times the district's 95th-percentile
building height) above the highest ground, 8 to 16 layers. The bundled Berlin
district is 54 × 54 × 8 cells of 50 m. Lattice speeds are kept low (0.1 at the
top, Mach 0.17) and physical speeds follow by scaling, since a flow at these
Reynolds numbers scales with its driving speed; buoyancy is scaled by the same
factor, with winds below 2 m/s solved as 2 m/s for the lattice's sake and the
buoyant acceleration bounded for stability.

**Solving.** From the inflow profile everywhere, the lattice runs for 0.8 of the
time the top wind takes to cross it (432 steps for Berlin), and the reported
field is the **mean over the last quarter** of those steps: the resolved flow is
unsteady (eddies shed from the canopy, sound waves crossing the lattice), and a
mean is what traffic and the observer need.

**Near the ground.** The first fluid layer's mean velocity is brought down to
10 m by the log law over each column's roughness: \( z_0 \approx 0.1 H \) and
displacement \( d \approx 0.7 H \) once the canopy is moderately dense
(\( \lambda_p \ge 0.2 \); Grimmond and Oke 1999), the open-ground value otherwise.

## Schedule and determinism

The flow is solved **on the hour**, from the background wind and the street
heating at that instant only, never from the previous solution, so a replay from
any checkpoint meets the same solves. At an hour where the wind has veered by
less than 5° and no column's heating has moved by 1 K since the last solve, the
last solution stands (in Berlin over a day: 15 solves, 10 kept). Every minute the
solution is turned through however far the background has veered since and
scaled to the background speed now, with **gusts** under storm cells: up to 60%
faster under a storm's core, where downdrafts spread out at the ground.

The lattice update is local to each cell, so one thread and eight compute the
same bits (a test holds it to this). The state a checkpoint holds is the
solution on the lattice (a few thousand numbers), the background, the storms
and each road's headwind; grid fields are rebuilt from those on demand.

## Couplings

| Into | How |
|---|---|
| **Traffic** | Each directed road's headwind, the wind at its midpoint against its direction, enters the [force balance](vehicle-dynamics.md#the-force-balance) as \( v_w \); the stream's speed factor is recomputed where a headwind has moved by 0.25 m/s. At urban speeds the effect is small; it matters for buses and on fast roads in strong wind |
| **Energy** | Energy per kilometre includes the headwind: driving into the wind costs more than with it |
| **Surface temperature** | Convection, McAdams \( h = 5.7 + 3.8u \), uses the local wind instead of a fixed 3 m/s |
| **Evaporation** | The bulk formula uses the local wind |
| **Storms** | A storm drifts downwind of the background wind at its start, instead of in a fixed per-storm direction |

## Outputs

| Where | What |
|---|---|
| `GET /api/v1/view/wind` | East and north components (m/s, at 10 m) at every lattice column, the lattice's placement, the background wind and the strongest wind |
| `GET /api/v1/view/fields/wind` | Wind speed on the environment grid |
| `GET /api/v1/view/environment` → `state.atmosphere` | Whether solved, when, how many solves and skips, scheme, lattice, iterations, steadiness, Mach number, density error, background wind and what the solution was solved for, the wind climate, near-surface mean and maximum, the canopy and where its heights came from |
| `GET /api/v1/view/road-environment` | `headwind_mps` per directed road |
| Observer | The **Wind** field overlay: the speed heatmap with moving streaks carried by the wind (still arrows under reduced motion); the **Wind** card in the City tab |

## Validation

`tests/environment/atmosphere_tests.cpp` (CTest `dstns_atmosphere`), on a
2.3 km flat district (46 × 46 × 8 cells of 50 m):

- **Building heights**: `height` in metres and feet, `building:levels`, estimates
  by kind, a non-numeric height ignored.
- **Open flat ground**: the wind is the background wind within 15% everywhere
  (1.01 to 1.10 of it, the surface layer accelerating slightly downstream as the
  coarse eddy viscosity mixes momentum down); a westerly blows east and a northerly
  south with no sideways drift, at the same speed (no preferred direction);
  Mach below 0.3, mean density error 6 × 10⁻⁵; one thread and three compute the
  same bits.
- **A block of tall buildings**, 64 buildings of 40 m on 400 m × 400 m (plan
  fraction 0.36): inside it the wind falls to 0.32 of the background against 1.11
  upwind; the wake 350 m downwind (0.69) is calmer than the same distance upwind
  and than open ground beside it; air diverted round the block speeds up the flow
  500 m to its side (to 1.25); far upwind the block is not felt.
- **A heated patch** (12 K over 600 m × 600 m, light wind): air rises over it and
  converges on it near the ground from all four sides.
- **The wind climate**: each latitude has its belt; westerlies blow from the west
  and trades from the north-east; a seed always has the same day's wind and
  another seed another; the afternoon is windier than before dawn.
- **The runtime**: the first minute solves the wind; over open ground it averages
  the background speed; a road's headwind is its twin's tailwind, and driving into
  it costs more energy; under a storm's core the wind rises to 1.6 times what it was;
  switched off, the wind leaves the roads and the map.
- **Through the engine**: rewinding and replaying reproduces the wind exactly; a
  storm drifts downwind (to within 0.001°).

## Performance

A solve on the Berlin lattice (23,328 cells, 432 steps) takes 0.15 to 0.4 s on
eight threads of an Apple M4, depending on what else the machine is doing. A
full simulated day on that district takes 30.3 s without the module and 34.9 s
with it.

## Limitations

- **Resolution.** 50 m cells: individual streets, courtyards and building edges
  are not resolved; the canopy is a porous drag, not solid walls, so street
  canyons and channelling between particular buildings are not represented.
- **Steady, and memoryless.** Each solve is a time-mean steady state; gusts are
  scaled, not simulated; the wind's response to a front or a storm's outflow is
  not modelled beyond the gust factor.
- **Buoyancy** uses the street's temperature as a diagnosed anomaly decaying with
  height; temperature is not transported by the flow, and stratification above
  the surface layer is not modelled.
- **Terrain** enters at the lattice's layer height (50 m): low relief is not felt.
- **Heights.** Nearly half of Berlin's buildings, and more elsewhere, have
  estimated heights.
- **CPU only.** The lattice update would map well to the GPU; it is fast enough
  on the CPU at this size that it has not been ported.
- **Crosswind** on vehicles is not modelled; only the component along the road.
