# Vehicle dynamics and road state

How terrain, wind and water change what traffic can do on a road. The aim is a
causal chain, not a scripted multiplier:

> slope → force → power → speed, and rain → water on the road → slower traffic
> → closure, instead of "uphill: speed × 0.9" or "rain: speed × 0.8".

| | |
|---|---|
| **Provides** | Every directed road's environmental state: grade, water, flood index, surface temperature, speed and capacity multipliers, closure, passability by vehicle class, energy per kilometre |
| **Reads** | Road grade ([terrain](terrain.md)); headwind ([urban wind](wind.md)); water under the road ([surface water](surface-water.md)); surface temperature ([DCM](solar.md)) |
| **Feeds** | The traffic step, through four per-edge inputs |
| **Switches** | Module `vehicle_dynamics` (grade and wind); module `das` (the wind itself); module `flooding` with `hydrology` (water) |
| **Code** | `src/environment/vehicles.cpp`, `EnvironmentRuntime::road` in `src/environment/runtime.cpp` |

## The force balance

The tractive force a vehicle needs, and the power it takes:

\[
F_t = m a + m g \sin\theta + C_{rr}\, m g \cos\theta + \tfrac12 \rho\, C_d A\, (v - v_w)\,|v - v_w|, \qquad P = F_t\, v,
\]

with \( \theta = \tan^{-1} g_{AB} \) the road's grade angle in the direction of
travel and \( v_w \) the wind component along it (positive with the vehicle; the
code takes a headwind, \( -v_w \)). \( \rho \) = 1.225 kg/m³.

DSTNS uses four representative classes. They are generic, not any
manufacturer's model:

| Class | \( m \) (kg) | \( C_d A \) (m²) | \( C_{rr} \) | Cruise budget (kW) | Wading depth | Share of the stream |
|---|---|---|---|---|---|---|
| Small passenger | 1,300 | 0.62 | 0.012 | 25 | 0.30 m | 62% |
| Large passenger | 2,100 | 0.95 | 0.012 | 35 | 0.40 m | 30% |
| Bus | 12,000 | 6.0 | 0.008 | 120 | 0.50 m | 8% |
| Emergency | 3,500 | 2.2 | 0.012 | 60 | 0.45 m | (routed separately) |

Drivers are taken to be **economical**: each class cruises within a power budget
of a third to a half of a typical rated power, never above the road's limit, and
does not race downhill. The steady power-limited speed is the \( v \le v_\text{limit} \)
with \( F_t(v)\, v = P_\text{budget} \), found by bisection (48 halvings) on the
monotonic power curve; if even the limit costs less than the budget, the limit.

**Grade factor.** The aggregate traffic stream's speed multiplier on a road is
each class's power-limited speed relative to its own on a flat, still road,
weighted by its share:

\[
f_\text{grade} = \frac{\sum_k s_k \min\!\big(1,\; v_k(g, v_w) / v_k(0, 0)\big)}{\sum_k s_k}.
\]

Each directed road's \( v_w \) is the [wind](wind.md) at its midpoint against
its direction of travel, so a road and its twin feel opposite winds; the factor
is recomputed whenever a road's headwind moves by 0.25 m/s.

It is **exactly 1** on flat ground in still air (each term is a speed divided by
itself), so a flat world behaves exactly as before; below 1 uphill, where the
bus share slows first; and never above 1 downhill. On a 10% climb with a 50 km/h limit both passenger classes keep their
speed, the bus slows from 13.9 to 9.3 m/s, and the stream's factor is 0.973.

**Energy.** Energy at the wheels per kilometre for a small passenger car at the
road's current speed, \( \max(0, F_t) \times 1000 / 3.6\times10^6 \) kWh. Braking
energy is neither spent nor recovered. An uphill arc costs more than twice its
downhill twin on a 10% slope.

Acceleration out of queues uses the traffic step's fixed rates; grade does not
yet change them.

## Water on the road

Pregnolato et al. (2017) fitted the speed of vehicles through standing water,
from observations, experiments and video, as

\[
v(w) = 0.0009\, w^2 - 0.5529\, w + 86.9448 \;\;\text{km/h}, \qquad w \text{ in mm},
\]

reaching a standstill for a car at 300 mm. DSTNS uses the ratio
\( f_\text{water} = v(w) / v(0) \) at the deepest water along the road: 1 dry, 0.28
at 150 mm, 0 at 300 mm and beyond. Each class has its own **wading depth**
(table above): deeper water makes the road impassable to it. The car's 300 mm is
Pregnolato's; the larger classes' depths are assumptions, stated as such.

## From the environment to the traffic step

Every second, before the traffic step, each directed road's state becomes four
inputs:

| Input | Value |
|---|---|
| Speed multiplier | \( f_\text{grade} \cdot f_\text{water} \) |
| Capacity multiplier | \( f_\text{water} \) (grade's effect on capacity is not modelled) |
| Closure | the deepest water ≥ a small car's wading depth |
| Flood index | \( \text{clamp}\big((w_\max - 0.02)/(0.30 - 0.02), 0, 1\big) \): puddles under 2 cm do not count |

With the surface-water model running, these replace the node flood model's
speed, capacity and closure factors (the step's `MOD_ENVIRONMENT`), and the flood
index becomes the road's flood value: flood events, notifications and the
observer's *Flooded* colour all come from simulated water. With multipliers of
exactly 1 the step's arithmetic is the identity, so a world without the
environment computes exactly what it did, and the CPU and Vulkan steps stay
bit-identical (`dstns_compute_equivalence`, `dstns_engine_compute`).

The rain factor (wet surface, spray and visibility: speed down 18%, capacity
15%, at full intensity) remains as it was.

## Road environmental state

`GET /api/v1/view/road-environment?offset=&limit=` (up to 5,000 per page) gives,
for each directed edge:

| Field | Meaning |
|---|---|
| `grade` | Rise over run in this direction |
| `water_max_m`, `water_mean_m` | Deepest and mean water over the cells the road crosses |
| `flood_index` | As above |
| `surface_temperature_c` | At the road's midpoint |
| `grade_speed_factor`, `water_speed_factor`, `speed_multiplier`, `capacity_multiplier` | As above |
| `closed_to_traffic` | Too deep for a small car |
| `passable` | By class: small passenger, large passenger, bus, emergency |
| `energy_kwh_per_km` | Small passenger car at the road's speed, into the road's headwind |
| `headwind_mps` | The wind against this direction of travel (negative: a tailwind) |

with the class parameters in `vehicle_classes`. Each edge in `/view/edges` carries
the same record under `environment`; the snapshot carries `water_depth_m`,
`env_speed_multiplier` and `env_closed` per edge.

## Validation

`tests/environment/vehicle_tests.cpp` (CTest `dstns_vehicles`):

- the force balance on the flat, uphill, downhill, into a headwind and with a
  tailwind; acceleration adds \( m a \);
- energy rises uphill and falls downhill; braking costs nothing;
- a car holds 60 km/h on the flat; a bus slows markedly on an 8% climb, does not
  speed downhill, and is slowed by a 15 m/s headwind at motorway speed;
- the stream's grade factor is exactly 1 on the flat, below 1 uphill, exactly 1
  downhill, and falls with steepness;
- Pregnolato's curve: 1 dry, the published value at 150 mm, 0 at 300 mm,
  never rising with depth;
- **scenario E**: on a 10% slope every climbing arc's twin descends by the same
  grade, climbing arcs are slowed and cost over twice the energy, descending
  arcs are not sped up, and traffic moves more slowly uphill;
- **scenario C**: a cloudburst into a bowl puts 60 roads under water, slows 64
  and closes 8 in the traffic step, their state reads flooded, and the water is
  still exactly accounted for.

## Limitations

- Representative classes, not a fleet: no trucks, motorcycles or bicycles, and
  the shares are fixed.
- Speed on grade is steady-state; acceleration out of queues ignores grade.
- Water speed uses the deepest water on the road, at 25 m resolution.
- Crosswind is not modelled: only the wind along the road. At urban speeds a
  headwind changes the stream's speed little; it changes energy more.
