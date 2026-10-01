# Mathematical model

The formulas DSTNS actually computes, with the constants in the code. Each
section names the function it comes from. For the ideas and the order in which
they run, read [Simulation engine](simulation-engine.md) first; for the
original, broader design, see the [Mathematical foundation](../design/mathematical-foundation.md)
specification.

!!! note "Implementation, not specification"
    Where this page and the design specification differ, this page describes
    the code. The specification proposed exponential attenuation and a
    BPR-style speed curve; the implementation uses the bounded linear
    attenuation and explicit queue dynamics below.

## Notation

| Symbol | Meaning | Units |
|---|---|---|
| \( t \) | Virtual time since midnight | s, \( 0 \le t \le 86400 \) |
| \( \Delta t \) | Physics step | always 1 s |
| \( v \in V \), \( e \in E \) | Node, directed edge | |
| \( L_e \), \( n_e \) | Edge length, lanes | m, — |
| \( v^{\text{free}}_e \), \( C_e \) | Free speed, base capacity | m/s, veh/h |
| \( r_v, f_v \) | Rain, flood at a node | 0 to 1 |
| \( s_v, \delta_v \) | Flood susceptibility, drainage (seeded per node) | 0 to 1 |

## The graph

\[
G = (V, E), \qquad |E| = 2M \text{ for } M \text{ road segments}
\]

Every segment yields two directed edges, twins of each other. For a one-way
road the reverse edge is kept for topology but marked *synthetic reverse*: it
carries no demand, capacity or speed, and routing never uses it. Positions are
true metres in a local equirectangular projection about the district's mean
coordinate \( (\varphi_0, \lambda_0) \):

\[
x = (\lambda - \lambda_0) \cdot 111320 \cdot \cos \varphi_0, \qquad y = (\varphi - \varphi_0) \cdot 111320
\]

(`OsmRoadLoader::load_xml`).

## Spatial kernel

Rain fields and place influence use the compactly supported Wendland \( C^2 \)
kernel (`wendland_c2`):

\[
W(d, R) =
\begin{cases}
(1-q)^4 (1+4q), & q = d/R < 1 \\
0, & \text{otherwise}
\end{cases}
\]

It is 1 at the centre, falls smoothly to exactly 0 at \( R \), and has a
continuous first and second derivative, so nothing jumps at the edge of a
storm.

## Weather

### Storm life cycle

A storm \( k \) with start \( t_0 \), end \( t_1 \), base radius \( R_k \) and
intensity \( I_k \) is at phase \( p = (t - t_0)/(t_1 - t_0) \in [0, 1) \)
(`evaluate_storm_state`):

\[
(\rho, \iota) =
\begin{cases}
\big(0.2 + 0.8 \sin 2\pi p,\; \sin 2\pi p\big) & p < 0.25 \quad \text{growth} \\
(1, 1) & 0.25 \le p \le 0.70 \quad \text{plateau} \\
\big(1 - 0.65\,\tau^2,\; \cos \tfrac{\pi}{2}\tau\big), \; \tau = \tfrac{p - 0.7}{0.3} & p > 0.70 \quad \text{decay}
\end{cases}
\]

Current radius \( \max(40, R_k \rho) \) m and intensity \( \operatorname{clamp}(I_k \iota, 0, 1) \).
The centre drifts up to \( 0.3 R_k\, p \) along a per-storm wind direction.

### Rain at a node

Storms combine like independent probabilities, so overlapping storms never
exceed 1:

\[
r_v = 1 - \prod_k \Big(1 - \iota_k I_k \, W\big(d(v, c_k), \rho_k R_k\big)\Big)
\]

### Flooding

With the flooding module on, each node's flood level integrates gain from rain
against drainage:

\[
f_v \leftarrow \operatorname{clamp}\Big(f_v + \Delta t \big(0.018\, r_v s_v - 0.004\, \delta_v f_v\big),\; 0,\; 1\Big)
\]

An edge takes the mean of its endpoints: \( r_e = (r_a + r_b)/2 \),
\( f_e = (f_a + f_b)/2 \).

### Scheduling

`dws.frequency` storms per day (default 3), placed by sorted uniform draws so
consecutive storms start at least 5 playback seconds apart, each lasting 45 to
120 virtual minutes (\( 45 + 75 u^{1.5} \)), with radius 100 to 600 m,
intensity \( 0.15 + 0.85 u^{1.7} \) and flood gain 0.35 to 0.95
(`ScenarioCompiler::plan_weather`).

## Demand

### Place profiles

Each modelled place kind has a diurnal multiplier: a floor plus Gaussian bumps,
wrapped across midnight (`diurnal_demand`):

\[
D_{\text{kind}}(t) = D_0 + \sum_j a_j \exp\!\left(-\tfrac12 \left(\frac{\min(|t - \mu_j|,\, 86400 - |t - \mu_j|)}{\sigma_j}\right)^2\right)
\]

| Kind | Weekday bumps (centre, width, height) | Weekend |
|---|---|---|
| School | 08:00 ±22 min +0.85; 15:15 ±28 min +0.75 | flat 1.0 |
| University | 09:00 +0.70; 13:00 +0.45; 17:30 +0.55 | 12:00 ±3 h +0.20 |
| Office | 08:45 +0.80; 12:30 +0.25; 17:45 +0.85 | flat 1.02 |
| Retail | 12:30 +0.40; 17:30 +0.70 | the same + 0.25 |
| Mall | 13:00 +0.55; 18:30 +0.80 | the same + 0.35 |
| Hospital | floor 1.15; 10:30 ±3 h +0.25 | the same |
| Pharmacy | 10:30 +0.30; 18:30 +0.45 | the same |
| Food | 12:45 +0.90; 19:30 +0.95 | the same + 0.15 |
| Transport | 08:15 +0.95; 17:45 +0.95 | 11:00 ±2.5 h +0.35 |
| Bus stop | 08:06 +0.55; 17:36 +0.60 | 11:30 ±2.5 h +0.22 |
| Parking | 09:00 +0.20; 17:00 +0.25 | the same |
| Park | 15:00 ±2.5 h +0.50 | the same + 0.45 |
| Industrial | 06:30 +0.70; 14:30 +0.55; 22:30 +0.30 | flat 1.05 |
| Culture | 15:00 +0.35; 20:00 +0.30 | the same + 0.30 |
| Hotel | 08:00 +0.35; 15:30 +0.45 | the same |
| Residential, worship, other | not modelled: always 1.0 | |

### Couplings

The profile is what a place does on an ordinary day; couplings are how it
responds to the network now. They multiply, and the result is clamped to
\( [1, 3] \) (`couple_demand`):

| Coupling | Applies to | Factor |
|---|---|---|
| closure | every modelled place | \( 1 + 0.55\,\beta \), \( \beta \) = blocked share of nearby capacity |
| distress | pharmacy, hospital | \( 1 + 0.60\,\eta \), \( \eta \) = nearby incident and flood pressure |
| shelter | retail, mall, food, transport, bus stop, culture | \( 1 + 0.35\, r \) |
| exposure | park | \( \max(0.2,\; 1 - 0.75\, r) \) |
| commerce | parking | \( 1 + 0.85\, \min(\kappa, 2) \), \( \kappa \) = mean excess demand of nearby commercial places |
| transit | bus stop | \( 1 + 0.70\, \min(\gamma, 2) \), \( \gamma \) = mean excess demand of nearby trip generators |

"Nearby" is within 400 m, reading at most the 24 strongest neighbours, so the
cost per tick stays bounded in dense centres. Every factor that is not 1 is
reported with the place, so any figure can be explained
(`/api/v1/view/places`).

### From places to roads

A place's excess demand \( D_i - 1 \) is spread over the edges around it with
weights \( W(d, 400) \), redistributed onto the edges that are still open and
reachable, and summed per edge, capped at 2 (`rebuild_edge_demand`). That is
the edge's *attraction* \( A_e \). The edge's demand is then

\[
\text{demand}_e = C_e \big(0.18 + 0.68\, P(t) + 0.60\, A_e + 0.35\, H_e\big)\, S_e(t),
\qquad P(t) = \tfrac12 + \tfrac12 \sin\!\Big(\frac{2\pi t}{86400} - 1.2\Big)
\]

where \( P \) is the network-wide day profile, \( H_e \) the edge's seeded hotspot
susceptibility, and \( S_e \) the strongest active surge covering it:

\[
S(t) = 1 + (\phi - 1)\sin^2(\pi \tau), \qquad \tau = \frac{t - t_s}{t_e - t_s}
\]

for a surge of factor \( \phi \) whose radius breathes between 35% and 100% of
its nominal value.

## Signals

Each controller has a cycle, a six-phase plan (green A, amber, all-red, green
B, amber, all-red) and an offset. Green time is split between the
north-south and east-west approach groups in proportion to arriving capacity;
each offset is the travel time at 13.9 m/s from the centroid of all controllers,
wrapped into the cycle, so signals a block apart turn green in sequence
(`ScenarioCompiler::plan_signals`). An approach's `signal_multiplier` is 1.0 on
green, 0.4 on amber and 0.08 on red; a manual override forces one group green
(1.0 against 0.08). See [Traffic signals](signals.md).

## Speed and capacity

\[
\begin{aligned}
v^{\text{target}}_e &= \begin{cases} 0 & \text{closed} \\ v^{\text{free}}_e \cdot m^{\text{sig}} \cdot (1 - 0.18\, r_e) \cdot \max(0.35,\, 1 - 0.55 f_e) \cdot m^{\text{op}}_v \cdot m^{\text{inc}}_v & \text{otherwise} \end{cases} \\
C^{\text{eff}}_e &= C_e \cdot m^{\text{sig}} \cdot (1 - 0.15\, r_e) \cdot \max(0.30,\, 1 - 0.60 f_e) \cdot m^{\text{op}}_C \cdot m^{\text{inc}}_C
\end{aligned}
\]

An edge is closed if an operator closed it, an active incident closes it, or
\( f_e \ge 0.98 \). Speed moves toward its target at no more than
2.4 m/s per second accelerating and 3.2 m/s per second braking.

## Queues

The vehicle load \( q_e \) relaxes toward a target set by demand and signal
delay, limited by the space on the road:

\[
q^{\text{target}}_e = \begin{cases}
0 & \text{closed} \\
\operatorname{clamp}\!\Big(\frac{\text{demand}_e}{\max(2,\, 3.6\, v^{\text{free}}_e)} \cdot \frac{L_e}{1000} \cdot \big(1 + 3.5 (1 - m^{\text{sig}})(0.5 + 0.5 S_e)\big),\; 0,\; \frac{L_e}{7.5} n_e\Big) & \text{otherwise}
\end{cases}
\]

filling at the inflow rate \( \max(0.4,\, \text{demand}_e \Delta t / 3600) \)
and draining at \( \max(0.7,\, 0.75\, n_e \Delta t) \) vehicles per step.

## Congestion

From the load \( q_e \) and count \( N_e = \operatorname{round}(q_e) \):

\[
\begin{aligned}
c^{\text{model}}_e &= \operatorname{clamp}\!\Big(\frac{N_e}{\max(1,\, 0.75\, L_e n_e / 7.5)}, 0, 1\Big) \\
\bar v_e &= v^{\text{eff}}_e (1 - 0.65\, c^{\text{model}}_e) \\
h_e &= \operatorname{round}\big(N_e (1 - 0.9\, m^{\text{sig}})\big) \quad \text{(halting vehicles)} \\
o_e &= \operatorname{clamp}\!\Big(\frac{5 N_e}{\max(1, L_e)\, n_e}, 0, 1\Big) \quad \text{(occupancy)} \\
c_e &= \begin{cases} 1 & \text{closed} \\ \operatorname{clamp}\big(0.60\, \ell_e + 0.25\, h_e/N_e + 0.15\, o_e,\; 0,\; 1\big) & \text{otherwise} \end{cases}
\end{aligned}
\]

where \( \ell_e = 1 - \bar v_e / v^{\text{free}}_e \) is the speed loss (0 for an
empty road). The network index is the length-and-lane-weighted mean over
traversable edges, smoothed with an exponential moving average of time constant
900 virtual seconds (`CongestionTracker::update`):

\[
C(t) = 100 \cdot \frac{\sum_e L_e n_e c_e}{\sum_e L_e n_e}, \qquad
\bar C \leftarrow \alpha C + (1 - \alpha) \bar C, \quad \alpha = 1 - e^{-\Delta t/900}
\]

sampled once per virtual minute into the history.

## Determinism

Every random quantity above is drawn from a counter-based generator keyed by a
SHA-256 sub-seed and a tuple of indices, never from global state, so the value
for (storm 2, intensity) is the same whatever else was drawn first. See
[Deterministic seeding](deterministic-seeding.md).

## Worked example: one edge, one second

This chains the model together for a single edge. It is computed from the formulas
above, assuming the edge's speed and queue have already converged to their targets.

**The edge.** A residential road, \( L = 200 \) m, one lane, \( v^{\text{free}} = 8.33 \) m/s,
\( C = 1100 \) veh/h. **The moment.** 08:00 (\( t = 28{,}800 \) s), light rain
(\( r = 0.4 \)), a little flooding (\( f = 0.1 \)), place attraction \( A_e = 0.30 \),
hotspot susceptibility \( H_e = 0.20 \), no surge (\( S = 1 \)).

**Demand.** The day profile at 08:00 is
\( P = \tfrac12 + \tfrac12\sin(2\pi \cdot 28800/86400 - 1.2) = 0.890 \), so

\[
\text{demand} = 1100\,(0.18 + 0.68 \cdot 0.890 + 0.60 \cdot 0.30 + 0.35 \cdot 0.20) \cdot 1 = 1138.7\ \text{veh/h}
\]

**Weather factors.** \( m^{\text{rain}}_v = 1 - 0.18 \cdot 0.4 = 0.928 \),
\( m^{\text{flood}}_v = \max(0.35,\ 1 - 0.55 \cdot 0.1) = 0.945 \),
\( m^{\text{rain}}_C = 0.94 \), \( m^{\text{flood}}_C = 0.94 \).

The signal decides the rest. Compare a green and a red approach:

| Quantity | Green (\( m^{\text{sig}} = 1 \)) | Red (\( m^{\text{sig}} = 0.08 \)) |
|---|---|---|
| Target speed \( v^{\text{free}} m^{\text{sig}} m^{\text{rain}}_v m^{\text{flood}}_v \) | 7.31 m/s | 0.58 m/s |
| Effective capacity \( C\, m^{\text{sig}} m^{\text{rain}}_C m^{\text{flood}}_C \) | 972 veh/h | 78 veh/h |
| Queue capacity \( L n_e / 7.5 \) | 26.7 veh | 26.7 veh |
| Baseline load \( \tfrac{\text{demand}}{\max(2,\ 3.6 v^{\text{free}})} \tfrac{L}{1000} \) | 7.59 veh | 7.59 veh |
| Target load (baseline \( \times (1 + 3.5(1 - m^{\text{sig}})(0.5 + 0.5S)) \), clamped) | 7.59 veh | 26.7 veh (4.22 times, clamped) |
| Vehicles \( N \) | 8 | 27 |
| Model congestion \( c^{\text{model}} = N / (0.75 \cdot 26.7) \) | 0.40 | 1.00 |
| Mean speed \( \bar v = v^{\text{eff}}(1 - 0.65\, c^{\text{model}}) \) | 5.41 m/s | 0.21 m/s |
| Halting vehicles \( \operatorname{round}(N(1 - 0.9\, m^{\text{sig}})) \) | 1 | 25 |
| Occupancy \( 5N / (L n_e) \) | 0.20 | 0.68 |
| Speed loss \( 1 - \bar v / v^{\text{free}} \) | 0.35 | 0.98 |
| **Congestion** \( 0.60\,\ell + 0.25\,h/N + 0.15\,o \) | **0.27** | **0.92** |

Reading the red column: a red light drops the road's capacity by a factor of 12 and
its target speed to under a tenth, so the queue target jumps to the road's physical
limit and the edge turns from mildly busy (0.27) to nearly jammed (0.92).

**How fast it gets there.** The state does not jump. Speed falls at the braking limit
of 3.2 m/s per second, so from 7.31 to 0.58 m/s takes \( (7.31 - 0.58)/3.2 \approx 2.1 \) s.
The queue fills at the inflow rate \( \max(0.4,\ \text{demand}/3600) = 0.4 \) veh/s, so
growing from 8 to 27 vehicles takes \( 19/0.4 = 48 \) s, and when the light turns green it
drains at \( \max(0.7,\ 0.75\, n_e) = 0.75 \) veh/s, clearing the 19 extra vehicles in
about 25 s. With the 76 s plan used on the events page, the opposing approach is red for 40 s, which
builds most of the 48 s the queue needs to fill, and the following 33 s green clears it in
about 25 s, three-quarters of the phase. That fill-and-drain rhythm is what gives the
network its visible pulse.
