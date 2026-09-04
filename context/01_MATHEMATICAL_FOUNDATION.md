# SUMO Deterministic Sandbox — Mathematical Foundation

**Document:** 01/03  
**Purpose:** Define the deterministic mathematical model, graph-generation rules, traffic/weather equations, and reproducibility contract for a C++ sandbox built on SUMO.  
**Design priority:** reproducibility > mathematical stability > physical plausibility > configurability > visual randomness.

---

## 1. Design axioms

The sandbox is modeled as a time-varying road graph

\[
G(t)=(V,E,\mathbf{X}_V(t),\mathbf{X}_E(t))
\]

where:

- \(V\) is the canonical set of road nodes;
- \(E\) is the canonical set of **directed** road edges;
- every physical road segment is represented by two directed edges after canonicalization;
- \(\mathbf{X}_V(t)\) contains static and dynamic node state;
- \(\mathbf{X}_E(t)\) contains static and dynamic edge state.

The following invariants are mandatory:

1. **Seed determinism:** identical `global_seed + config + input OSM snapshot + software manifest + control journal` produces the same logical scenario.
2. **Module isolation:** adding a random draw to DWS must not alter map selection, bus stops, buildings, traffic hotspots, or another module.
3. **Stable IDs:** node/edge numbers are assigned only after topology canonicalization and never depend on hash-table iteration order.
4. **Single-writer runtime:** only the simulation thread may mutate simulation state. API threads submit commands to a deterministic command queue.
5. **No hidden SUMO routing dependence:** the sandbox owns route selection and topology algorithms. SUMO is used for microscopic traffic evolution, lane/junction behavior, and signal execution.
6. **Bounded state:** normalized dynamic fields are in \([0,1]\) unless explicitly documented otherwise.
7. **Smooth influence:** normal demand/weather changes use continuous or piecewise-smooth kernels; abrupt discontinuities are reserved for explicit control events.
8. **Reproducible preprocessing:** graph iteration is always canonicalized by stable IDs before any selection algorithm runs.

SUMO itself is deterministic by default for a fixed seed and inputs, and uses multiple RNG instances internally; however, SUMO documents some platform/version-dependent reproducibility caveats, including geographic projection differences through PROJ. Therefore the sandbox must keep a separate reproducibility manifest and should pin SUMO/PROJ versions for strict replay.

---

## 2. Three-clock model

A physically coherent design must distinguish three notions of time.

### 2.1 Playback time

Let

\[
T_P \in [60,1200]\text{ seconds}
\]

be the user-selected `simulation_time` / playback duration. Default:

\[
T_P=60\text{ s}
\]

Let playback position be \(t_P\in[0,T_P]\).

Define the normalized simulation percentage

\[
p(t_P)=\operatorname{clamp}\left(\frac{t_P}{T_P},0,1\right).
\]

This is the canonical `simulation_percentage`.

### 2.2 Simulated day clock

One playback cycle represents one virtual day:

\[
t_D = \left\lfloor 86400\,p \right\rfloor,
\]

with \(t_D\in[0,86399]\) seconds.

Human-readable time is:

\[
H=\left\lfloor\frac{t_D}{3600}\right\rfloor,
\quad
M=\left\lfloor\frac{t_D\bmod3600}{60}\right\rfloor,
\quad
S=t_D\bmod60.
\]

`simulated_current_time` is therefore derived, never independently stored.

### 2.3 SUMO physics time

For traffic realism, SUMO should evolve on the **virtual-day timescale**, not on the 60–1200 second playback clock. The target engine time is

\[
t_{SUMO}=t_D.
\]

Hence a 90-second traffic-light cycle remains 90 virtual seconds rather than being compressed into milliseconds.

The playback layer is a compression/visualization layer. The simulation controller advances SUMO until `t_SUMO` reaches the target virtual time implied by playback. If the machine cannot compute fast enough, playback should **lag** rather than skip physical SUMO steps.

This avoids the major failure mode in which a 60-second run is treated as only 60 seconds of vehicle physics while demand is forced through 24 hours.

### 2.4 Playback-to-day conversion

The nominal acceleration factor is

\[
A_T=\frac{86400}{T_P}.
\]

Examples:

| Playback duration | Virtual seconds per playback second | Virtual minutes per playback second |
|---:|---:|---:|
| 60 s | 1440 | 24 min |
| 300 s | 288 | 4.8 min |
| 600 s | 144 | 2.4 min |
| 1200 s | 72 | 1.2 min |

The simulation output remains deterministic because events are tied to normalized percentage/virtual time, not to wall-clock scheduling jitter.

---

## 3. Deterministic RNG hierarchy

### 3.1 Why ordinary chained RNG calls are insufficient

A design such as:

```text
global_rng -> draw seed for traffic -> draw seed for weather -> draw seed for map
```

is fragile. Adding one draw before the Weather seed shifts every later stream.

The sandbox should instead use **keyed, counter-based random streams**. Counter-based generators such as Philox are designed so that a random value is a deterministic function of a key and counter, with no mutable stream position required.

### 3.2 Global seed

Use a 128-bit logical seed:

\[
S_G \in \{0,1\}^{128}.
\]

Configuration behavior:

- `seed = explicit`: parse a user-provided 64/128-bit integer/string into \(S_G\).
- `seed = auto`: read 128 bits from the operating system CSPRNG **once**, then immediately print and persist the resulting seed.
- Every run response must expose the resolved seed.

The auto-generated run is random only at seed creation; after that it is fully replayable.

### 3.3 Module key derivation

For module identifier string \(m\), derive

\[
K_m = \operatorname{Trunc}_{128}
\left(
\operatorname{SHA256}(\texttt{"SUMO-SANDBOX/V1"}\|S_G\|m)
\right).
\]

Recommended module keys:

```text
MAP_SELECTION
TOPOLOGY_NORMALIZATION
BUS_STOPS
BUILDINGS
TRAFFIC_CONTROL
TRAFFIC_OD
TRAFFIC_SIGNALS
DWS_SCHEDULE
DWS_FIELD
DAY_SELECTOR
```

A future module gets a new name/key and therefore cannot perturb existing streams.

### 3.4 Object-keyed draws

A random draw should be addressed by semantic identity:

\[
R = \operatorname{Philox}(K_m,C),
\]

with counter fields conceptually containing:

```text
(object_id, event_index, purpose_tag, draw_index)
```

Examples:

```text
Traffic hotspot score for edge 901:
    RNG(TRAFFIC_CONTROL, edge=901, purpose=HOTSPOT_SCORE, draw=0)

DWS event #4 radius:
    RNG(DWS_SCHEDULE, event=4, purpose=RADIUS, draw=0)

Building type near stop #12:
    RNG(BUILDINGS, stop=12, purpose=TYPE, draw=0)
```

This makes outcomes independent of loop order and thread scheduling.

### 3.5 Uniform floating point

For a 32-bit unsigned result \(x\), map to an open unit interval with

\[
u=\frac{x+0.5}{2^{32}}, \qquad 0<u<1.
\]

Avoid `std::uniform_real_distribution` as part of the reproducibility contract because library distribution algorithms are not the right layer to rely on for cross-implementation bitwise behavior.

### 3.6 Unbiased bounded integers

To map an RNG word to \([0,n)\), do not use `x % n` unless \(n\) divides \(2^{32}\). Use rejection sampling:

\[
L = 2^{32} - (2^{32}\bmod n).
\]

Draw \(x\) until \(x<L\), then return

\[
k=x\bmod n.
\]

Every rejection uses a deterministic increment of `draw_index`.

### 3.7 Strict replay mode

For the strongest reproducibility:

- store geographic coordinates as integer `lat_e7/lon_e7`;
- store linear geometry internally in integer millimetres after projection;
- store normalized state in fixed-point `Q16.16` or `Q24.40` where practical;
- use canonical polynomial kernels where possible;
- where `exp`, `log`, `tanh`, or projection libraries are required, pin library versions in the run manifest or use build-time lookup tables.

This prevents tiny floating-point differences from becoming event-order differences near thresholds.

---

## 4. OSM road-only extraction

### 4.1 Eligible source objects

Only OSM road topology is retained. The source parser should retain:

- nodes referenced by accepted road ways;
- ways carrying an accepted `highway=*` classification;
- road-relevant tags such as `lanes`, `maxspeed`, `access`, `motor_vehicle`, `oneway`, `junction`, `highway=traffic_signals`;
- geometry required for edge polylines.

Ignore:

- buildings/polygons;
- land use;
- waterways;
- railways unless explicitly enabled later;
- POIs;
- footways, steps, pedestrian-only ways and paths that reject motor vehicles;
- unrelated standalone nodes.

OSM's `oneway` semantics include `yes`, `-1`, explicit `no`, roundabouts, and motorway defaults. The source direction is recorded even though the sandbox later makes the topology bidirectional.

### 4.2 Source filtering policy

Use an explicit versioned allowlist, e.g.:

```text
motorway, trunk, primary, secondary, tertiary,
unclassified, residential, living_street,
service, *_link
```

Then apply access-tag logic. Never infer acceptance only from string prefix.

A `road_filter_version` is persisted in the manifest.

---

## 5. Seed-to-map selection

The goal is to convert a global seed into a reproducible **road-network region**, not merely a random latitude/longitude that may land in an ocean.

### 5.1 Road Anchor Index

Before runtime, build a compact `RoadAnchorIndex` over the available OSM snapshot. Each eligible road node contributes:

```text
osm_node_id
lat_e7
lon_e7
tile_id
component_hint (optional)
```

Nodes are sorted by canonical OSM ID inside each tile.

If a planet-scale snapshot is supported, an equal-area spherical indexing transform is useful for coarse tiling:

\[
u=\frac{\lambda+\pi}{2\pi},
\qquad
v=\frac{\sin\varphi+1}{2},
\]

where \(\lambda\) is longitude and \(\varphi\) latitude in radians. Quantize \((u,v)\) into a fixed grid. The `sin(latitude)` transform prevents the severe polar area distortion of a naive latitude grid.

Runtime selection does **not** need to choose tiles uniformly. A simpler and more natural rule is uniform selection over eligible road anchor nodes. Dense road networks then naturally receive proportionally more probability mass than empty terrain.

### 5.2 Root node selection

Let the sorted eligible anchor list contain \(M\) nodes. Draw

\[
i_0 = U_{int}(0,M-1)
\]

from the `MAP_SELECTION` stream and choose root \(r=V[i_0]\).

If the connected component containing \(r\) is too small for the configured minimum, use deterministic retry counter \(a=1,2,\ldots\) rather than consuming a shared mutable stream.

### 5.3 Connected Radial Frontier Growth (CRFG)

For a source component larger than the node budget, select a compact connected induced region containing at most

\[
N_{max}=50,000
\]

canonical road nodes.

Let \(d_E(r,v)\) be projected Euclidean distance from root to candidate node. CRFG is:

1. `selected = {r}`.
2. Push all eligible neighbours of `r` into a min-heap keyed by
   \[
   (d_E(r,v),\;\text{road_class_penalty}(v),\;\text{canonical_node_id}).
   \]
3. Pop the smallest candidate.
4. If not selected, add it and push its eligible neighbours.
5. Continue until `|selected| = N_target` or frontier is empty.
6. Keep every source road segment whose two endpoints are selected.
7. Run a boundary closure pass so parallel ways between already-selected endpoints are not accidentally discarded.

Properties:

- connected by construction;
- roughly compact/circular rather than producing long motorway tentacles;
- \(O((V+E)\log V)\) worst-case in the selected source component;
- deterministic due to canonical tie-breaking;
- not dependent on SUMO routing.

### 5.4 Geometry quality condition

After extraction compute:

\[
\rho = \frac{4\pi A}{P^2}
\]

where \(A\) is the convex-hull area and \(P\) its perimeter. \(\rho=1\) is perfectly circular; very low \(\rho\) indicates a thin or pathological region.

If \(\rho<\rho_{min}\), or if the graph has insufficient intersection density, deterministically reject the anchor and retry. Recommended `rho_min` is configurable; a conservative synthetic default is `0.08–0.15`, not a universal geographic truth.

---

## 6. Deterministic Road-Network Canonicalization Pipeline (DRNCP)

This is the technical name for the requested pre-check/pre-processing stage.

**DRNCP = Deterministic Road-Network Canonicalization Pipeline**

Stages:

### DRNCP-1 — Structural filtering

- keep motor-road topology only;
- remove orphan nodes;
- split ways at intersections and attribute changes;
- reject zero-length/self-loop geometry unless explicitly valid;
- normalize duplicated consecutive coordinates.

### DRNCP-2 — Direction normalization

For every physical source segment \(s=\{u,v\}\), create twin directed edges:

\[
e^+=(u,v),\qquad e^-=(v,u).
\]

Even if OSM marks the source as one-way, both are present.

Preserve:

```text
source_oneway: bool
source_oneway_direction: +1/-1/0
synthetic_reverse: bool
reverse_twin_edge_id
```

Thus the sandbox is bidirectional without destroying provenance.

### DRNCP-3 — Attribute completion

Resolve missing attributes using road-class defaults:

- lane count;
- free-flow speed \(v_f\);
- base lane capacity \(s_l\);
- priority/class;
- vehicle permissions.

Every inferred value receives an `inferred_*` flag.

### DRNCP-4 — Topology repair

- remove isolated nodes;
- detect small disconnected components;
- select the root component;
- optionally keep only components above a configured threshold;
- validate twin-edge symmetry.

### DRNCP-5 — Stable numbering

Canonical node number:

1. sort by `(osm_node_id, lat_e7, lon_e7)`;
2. assign `node_number = 0..N-1`.

Canonical edge number:

1. sort by `(from_node_number, to_node_number, source_way_id, source_segment_index)`;
2. assign `edge_number = 0..M-1`.

Never use pointer address, unordered-map iteration, or SUMO-generated internal IDs for sandbox numbering.

### DRNCP-6 — Feasibility checks

Reject or repair if any of the following fail:

- `N_nodes <= 50,000`;
- every edge has existing endpoints;
- every physical segment has exactly one reverse twin;
- edge length \(>0\);
- lane count \(>=1\);
- free speed \(>0\);
- the primary component contains at least configured minimum nodes;
- NaN/Inf-free numeric state;
- bus-stop/signal/building placement constraints satisfiable.

---

## 7. Canonical graph geometry

For every edge \(e\):

- length: \(L_e\) metres;
- free speed: \(v_{f,e}\) m/s;
- free travel time:

\[
t_{0,e}=\frac{L_e}{v_{f,e}}.
\]

Use projected coordinates for local distance and polyline geometry.

For a point/node \(c\) and road polyline \(P_e\), spatial distance to an edge is

\[
d(c,e)=\min_{x\in P_e}\|x-c\|_2,
\]

computed by point-to-segment distance over the edge polyline. This is more correct than taking the minimum endpoint distance.

---

## 8. Compact spatial influence kernel

Weather/buildings need a radius-limited influence that smoothly reaches exactly zero at the boundary.

Use the compact Wendland \(C^2\) radial kernel:

\[
W(q)=
\begin{cases}
(1-q)^4(4q+1),&0\le q<1\\
0,&q\ge1
\end{cases}
\]

with

\[
q=\frac{d}{R}.
\]

Properties:

- \(W(0)=1\);
- \(W(R)=0\);
- finite radius — no invisible long tail;
- polynomial — deterministic and cheap;
- smooth first/second derivatives near the support boundary.

This kernel should be the default for building and DWS spatial influence.

---

## 9. Smooth time-window / `Tmax` kernel

A `Tmax` entry is stored as a normalized-day interval

\[
[a,b],\qquad 0\le a<b\le1.
\]

Within the interval define

\[
z=\frac{p-a}{b-a}.
\]

A symmetric compact “binomial-like” pulse is

\[
B_k(z)=
\begin{cases}
\left(4z(1-z)\right)^k,&0\le z\le1\\
0,&\text{otherwise}
\end{cases}
\]

where integer \(k\ge1\).

- `k=1`: broad, rounded demand;
- `k=2`: medium concentration;
- `k=3..4`: sharper school/office peaks.

For asymmetric arrival/departure behavior use integer Beta-shaped exponents:

\[
B_{a,b}(z)=
\frac{z^a(1-z)^b}
{z_*^a(1-z_*)^b},
\qquad z_*=\frac{a}{a+b}.
\]

This is normalized to a maximum of 1.

For a building \(j\) with multiple `Tmax` intervals, temporal activation is

\[
T_j(p)=1-\prod_{r\in Tmax_j}\left(1-B_r(p)\right).
\]

The noisy-OR combination prevents two overlapping windows from exceeding 1.

---

## 10. Synthetic building / place model

A building is a demand-attractor metadata object attached to a canonical road node, not an OSM polygon.

```text
BuildingEffect {
    type: SCHOOL | OFFICE | MALL | STORE
    anchor_node
    tmax_ranges[]
    temporal_shape
    impact in [0,1]
    radius_m
    weekend_amplitude_multiplier
    weekend_radius_multiplier
}
```

### 10.1 Default weekday ranges

Percentages below are fractions of a 24-hour day.

| Type | Suggested `Tmax` ranges | Interpretation |
|---|---|---|
| School | `[7/24, 9/24]`, `[15/24, 16.5/24]` | arrival and dispersal |
| Office | `[7.5/24, 10/24]`, `[16.5/24, 19.5/24]` | commute peaks |
| Mall | `[10.5/24, 22.5/24]` | broad daytime/evening attraction |
| Store | `[8.5/24, 21.5/24]` | weak long-duration attraction |

These are defaults for a synthetic sandbox, not universal empirical schedules. Keep them in configuration.

### 10.2 Building effect on an object

For building \(j\) and road object \(x\):

\[
I_j(x,p)=A_j\,T_j(p)\,W\!\left(\frac{d(j,x)}{R_j}\right),
\]

where \(A_j\in[0,1]\) is `impact`.

Combine buildings without overflow:

\[
I_B(x,p)=1-\prod_j(1-I_j(x,p)).
\]

### 10.3 Weekend/weekday parameter

`day=0` means weekday, `day=1` means weekend.

If not forced in startup configuration, derive naturally from the seed with a 5:2 weighting:

\[
P(day=0)=\frac57,\qquad P(day=1)=\frac27.
\]

Suggested weekend multipliers:

| Type | Impact multiplier | Radius multiplier |
|---|---:|---:|
| School | 0.10 | 0.80 |
| Office | 0.35 | 0.90 |
| Mall | 1.25 | 1.15 |
| Store | 1.15 | 1.10 |

Clamp final impact to \([0,1]\). These are deliberately configurable synthetic defaults.

---

## 11. Bus-stop node placement

Transit guidance commonly treats stop spacing as a tradeoff between access distance and bus travel time. Indian BRT guidance gives a useful synthetic target of approximately 500 m, with a 300–800 m range.

The sandbox needs deterministic stops that are neither clustered nor unrealistically sparse.

### 11.1 Candidate set

A node is a stop candidate if:

- it is not a dead-end unless required for coverage;
- it is not on a motorway-only segment;
- it has an adjacent lane/edge long enough to materialize a SUMO stop;
- it is not within an exclusion radius of another special infrastructure node unless configuration permits it.

Candidate desirability:

\[
S_v =
 w_1 C_{road}(v)
+w_2 C_{degree}(v)
+w_3 C_{localDensity}(v)
-w_4 C_{junctionPenalty}(v).
\]

All components are normalized to \([0,1]\).

### 11.2 Deterministic scan origin

The scan root is always the CRFG map root node. Compute a canonical BFS shell rank from this root with neighbours visited in ascending canonical node ID.

Candidate ordering is then

```text
(BFS_shell, -desirability, canonical_node_id)
```

so the same exact graph always begins stop placement from the same place.

### 11.3 Graph Poisson-disc acceptance

Let:

\[
d_{min}=300m,
\quad d_{target}=500m,
\quad d_{max}=800m
\]

by default.

Scan candidates in deterministic order. Accept candidate \(v\) if its road-network distance to all accepted stop anchors satisfies

\[
d_G(v,S)\ge d_{min}.
\]

A truncated custom shortest-path search only needs to explore up to \(d_{min}\) to determine acceptance.

### 11.4 Coverage repair

After the first pass, compute distance of every eligible road node to the nearest accepted stop by a deterministic multi-source graph expansion.

If

\[
\max_v d_G(v,S)>d_{max},
\]

choose the feasible candidate maximizing nearest-stop distance, with tie-break `(higher desirability, lower node_id)`, add it, and repeat.

This produces a deterministic approximate graph `k-center` solution with both minimum spacing and maximum-coverage goals.

### 11.5 SUMO materialization

The sandbox node remains the logical `BUS_STOP` anchor. The corresponding SUMO `<busStop>` is placed on a selected adjacent lane, preferably on the far side of an intersection where feasible, with deterministic lane and position tie-breaking.

---

## 12. Building placement around bus stops

Buildings should appear near transit but not exactly on every stop.

For each bus stop \(s\), define a graph-distance annulus:

\[
R_{near}=80m,
\qquad
R_{far}=250m.
\]

Candidate nodes satisfy

\[
R_{near}\le d_G(s,v)\le R_{far}.
\]

Use the `BUILDINGS` stream keyed by stop number to determine:

1. whether a building is created;
2. building type;
3. selected candidate rank;
4. impact \(A\);
5. radius \(R\);
6. time-shape parameters.

A minimum inter-building distance prevents unrealistic clustering.

This gives the “around the corner / a few nodes away” effect while remaining seed-stable.

---

## 13. Traffic demand model

### 13.1 Baseline road capacity

Let base capacity of edge \(e\) be

\[
C_{0,e}=n_{lanes,e}\,c_{lane,e},
\]

where `c_lane` is a road-class parameter in vehicles/hour/lane.

SUMO remains responsible for microscopic capacity behavior; this analytical capacity is used for demand pressure, routing cost, and event scoring.

### 13.2 Base demand

Define edge/zone baseline demand \(Q_{base,e}\) from:

- road class;
- route-probe centrality;
- nearby building attraction;
- bus-stop proximity;
- traffic-hotspot susceptibility.

At virtual time \(p\):

\[
Q_e(p)=Q_{base,e}\left[1+\eta_B I_B(e,p)+\eta_H H_e(p)\right].
\]

### 13.3 Time-stable trip generation

Avoid “one Bernoulli draw every SUMO tick”; changing the step length would change the random sequence.

Instead divide the virtual day into fixed bins, e.g. 5 minutes:

\[
\Delta_D=300s,
\qquad N_B=288.
\]

For each OD zone/bin, derive a deterministic Poisson count using a counter keyed by `(zone, bin)`, then assign departure offsets within the bin using counter-keyed uniforms. All departures are precompiled and sorted.

This makes demand invariant to runtime stepping and rendering rate.

---

## 14. Traffic Control RNG and recurrent congestion hotspots

### 14.1 Number of hotspot edges

Let \(|E|=M\). Draw a hotspot fraction

\[
f_H=f_{min}+(f_{max}-f_{min})u^2,
\]

with defaults such as

\[
f_{min}=0.002,
\quad f_{max}=0.015.
\]

Then

\[
K_H=\operatorname{clamp}(\operatorname{round}(M f_H),K_{min},K_{max}).
\]

Squaring \(u\) favors modest hotspot counts while still allowing denser scenarios.

### 14.2 Route-Probe Centrality

Rather than running exact all-pairs betweenness on 50,000 nodes, estimate functional importance with deterministic route probes:

1. choose \(P\) OD node pairs from the `TRAFFIC_CONTROL` stream;
2. route each pair using the sandbox's deterministic A*;
3. count traversals \(b_e\);
4. normalize

\[
\hat b_e=\frac{b_e}{\max_j b_j+\epsilon}.
\]

`P=256..2048` is configurable depending on preprocessing budget.

### 14.3 Hotspot selection score

For edge \(e\):

\[
W_e=
(\epsilon+\hat b_e)^{\gamma_b}
(\epsilon+R_e)^{\gamma_r}
(\epsilon+J_e)^{\gamma_j},
\]

where:

- \(R_e\): road-class suitability;
- \(J_e\): junction/signal proximity score.

Use deterministic weighted sampling without replacement to choose \(K_H\) edges.

Each selected edge gets a susceptibility

\[
h_e=h_{min}+(h_{max}-h_{min})u_e.
\]

Hotspots do not directly force a fake jam; they increase demand/capacity pressure so queues arise through the traffic model and signals.

---

## 15. Analytical congestion model

### 15.1 Effective capacity

At edge \(e\), time \(t\):

\[
C_e^{eff}(t)
=C_{0,e}
M_{signal,e}(t)
M_{weatherCap,e}(t)
M_{floodCap,e}(t)
M_{manualCap,e}(t).
\]

Every multiplier is in \([0,1]\).

### 15.2 BPR-style pressure

Let

\[
x_e(t)=\frac{Q_e(t)}{\max(C_e^{eff}(t),\epsilon)}.
\]

Use the classic BPR-like volume-delay form

\[
t_e=t_{0,e}\left(1+\alpha x_e^\beta\right).
\]

A conventional starting point is

\[
\alpha=0.15,
\qquad \beta=4,
\]

but these parameters should be calibrated per road class when observations are available.

Define dimensionless delay excess

\[
D_e=\frac{t_e}{t_{0,e}}-1=\alpha x_e^\beta.
\]

Map it to normalized model congestion:

\[
C^{model}_e=\frac{D_e}{1+D_e}.
\]

This yields \(0\le C^{model}<1\) and rises nonlinearly near/above capacity.

### 15.3 Observed SUMO congestion

At each telemetry interval derive:

\[
S_e=\operatorname{clamp}\left(1-\frac{\bar v_e}{v_e^{eff}},0,1\right),
\]

\[
Q_e^{halt}=\frac{N_{halting,e}}{\max(N_{veh,e},1)},
\]

and normalized occupancy \(O_e\).

Then

\[
C^{obs}_e = 1-(1-S_e)(1-Q_e^{halt})(1-O_e).
\]

Final instantaneous congestion:

\[
C^{inst}_e=w_m C^{model}_e+(1-w_m)C^{obs}_e,
\qquad 0\le w_m\le1.
\]

Smooth with a rational EMA that avoids `exp`:

\[
\lambda=\frac{\tau_c}{\tau_c+\Delta t},
\]

\[
C_e(t)=\lambda C_e(t-\Delta t)+(1-\lambda)C^{inst}_e(t).
\]

---

## 16. Deterministic route planner

The sandbox should not call SUMO's route finder.

### 16.1 A* cost

Dynamic route cost:

\[
w_e(t)=t_{0,e}\left(1+\alpha x_e(t)^\beta\right)+P_e(t),
\]

where \(P_e\) may contain manual/event penalties.

### 16.2 Admissible heuristic

For destination \(d\):

\[
h(v)=\frac{d_E(v,d)}{v_{max,network}}.
\]

Since no road can legally exceed the configured network maximum free speed, this is an admissible lower bound on travel time.

### 16.3 Deterministic tie-break

Priority tuple:

```text
(f = g+h, g, canonical_node_id)
```

Neighbour edges are scanned by ascending edge number.

This ensures the same equal-cost path is chosen every run.

---

## 17. Traffic-signal selection

### 17.1 Candidate intersections

A node is a synthetic signal candidate when:

- topological degree is at least 3;
- it connects sufficiently important road classes;
- junction geometry is not degenerate;
- it is not too close to an accepted signal.

OSM `highway=traffic_signals` may be given high/mandatory candidate priority because that tag is part of road topology metadata.

### 17.2 Minimum spacing

Use graph/Euclidean Poisson-disc selection with configurable minimum, e.g. `100–250 m`, dependent on network density.

### 17.3 Webster timing baseline

For phase \(i\), critical flow ratio

\[
y_i=\frac{q_i}{s_i},
\qquad Y=\sum_i y_i.
\]

Total lost time per cycle is \(L\). Webster's classical starting point is

\[
C_0=\frac{1.5L+5}{1-Y}.
\]

Because this becomes unstable as \(Y\to1\), use

\[
Y'=\min(Y,Y_{cap})
\]

and

\[
C=\operatorname{clamp}
\left(
\frac{1.5L+5}{1-Y'},
C_{min},C_{max}
\right),
\]

with conservative defaults such as

```text
Y_cap = 0.90
C_min = 40 s
C_max = 120 s
```

Effective green available:

\[
G=C-L.
\]

Green split:

\[
g_i=G\frac{y_i}{\sum_j y_j}.
\]

For a movement/lane group with saturation flow \(s_i\), its signal-limited capacity is

\[
c_i=s_i\frac{g_i}{C}.
\]

The sandbox can aggregate the applicable lane-group ratios into the edge-level factor \(M_{signal,e}\). This is preferable to inventing a separate arbitrary signal penalty because it preserves the physical meaning of green-time availability.

Apply minimum green constraints and renormalize the remaining green time.

Signals should create congestion through normal queueing when demand grows; avoid deliberately setting absurd red times merely to manufacture jams.

---

## 18. Dynamic Weather Simulation (DWS)

DWS is deterministic and event-based.

### 18.1 Event structure

Each event \(k\) has:

```text
event_id
epicenter_node
start_percentage
end_percentage
peak_rain_intensity_norm in [0,1]
radius_m
flood_gain
recovery_rate
```

The epicenter is always a canonical node, never a raw XY coordinate in the public event model.

### 18.2 DWS frequency

If configuration supplies `dws_frequency = F`, use it.

Otherwise derive a deterministic integer from `DWS_SCHEDULE`. The default distribution should be configurable; for a neutral sandbox a small range such as `1..4 events/day-cycle` is sensible.

### 18.3 Five-playback-second minimum separation

The user's five-second rule is most useful in **playback time**.

Let

\[
\delta_P=5s.
\]

For \(F\) event starts, feasibility requires

\[
(F-1)\delta_P<T_P.
\]

Generate \(F\) independent uniforms \(u_i\), sort them into order statistics

\[
u_{(0)}\le\cdots\le u_{(F-1)}.
\]

Define slack

\[
S=T_P-(F-1)\delta_P.
\]

Then event start times are

\[
t_{P,i}=i\delta_P+S u_{(i)}.
\]

Therefore

\[
t_{P,i+1}-t_{P,i}\ge\delta_P
\]

by construction, with no rejection loop.

Convert to percentage:

\[
p_i=t_{P,i}/T_P.
\]

This is deterministic, ordered, and enforces the exact minimum spacing.

### 18.4 Epicenter selection

Select a node using weighted sampling:

\[
P(v)\propto \epsilon+S^{flood}_v,
\]

where \(S^{flood}\) is static synthetic flood susceptibility. If uniform epicenters are desired, set every weight to 1.

### 18.5 Spatial rain field

For event \(k\), node/edge object \(x\):

\[
I_k^{space}(x)=
W\!\left(\frac{d(x,c_k)}{R_k}\right).
\]

### 18.6 Temporal rain field

For event start \(a_k\) and end \(b_k\) in day percentage:

\[
I_k^{time}(p)=B_{a,b}\left(\frac{p-a_k}{b_k-a_k}\right).
\]

Use a mildly asymmetric pulse if desired: faster onset and slower decay can be represented by integer exponents such as `(a=2,b=3)` after confirming the desired orientation.

### 18.7 Total rainfall intensity

\[
I^{rain}_x(p)
=1-\prod_k
\left(
1-I_{peak,k}I_k^{space}(x)I_k^{time}(p)
\right).
\]

Multiple overlapping events remain bounded in \([0,1]\).

---

## 19. Synthetic flood susceptibility and drainage

Because the requested import intentionally discards non-road map layers, the base system does not possess terrain/elevation/drainage truth. Therefore flooding must be labeled **synthetic** unless a DEM/drainage dataset is later added.

### 19.1 Spatially coherent susceptibility field

Generate node noise

\[
\xi_v=2u_v-1.
\]

Apply \(K\) deterministic graph-smoothing iterations:

\[
h_v^{(k+1)}
=(1-\lambda_h)h_v^{(k)}
+\lambda_h
\frac{\sum_{u\in N(v)}w_{uv}h_u^{(k)}}
{\sum_{u\in N(v)}w_{uv}}.
\]

Normalize final \(h_v\) into \([0,1]\):

\[
S^{flood}_v=\frac{h_v-h_{min}}{h_{max}-h_{min}+\epsilon}.
\]

This produces coherent vulnerable patches instead of independent salt-and-pepper randomness.

### 19.2 Drainage coefficient

\[
D_v=D_{min}+(D_{max}-D_{min})(1-S^{flood}_v).
\]

High susceptibility implies slower drainage.

---

## 20. Flood-state dynamics

Let \(F_x\in[0,1]\) be normalized flood state for a node/edge.

Use a bounded reservoir model:

\[
\frac{dF_x}{dt}
=k_{in}I_x^{rain}(1-F_x)
-k_{out}D_xF_x.
\]

Discrete update at virtual step \(\Delta t\):

\[
F_{x,t+1}=
\operatorname{clamp}
\left(
F_{x,t}
+\Delta t
\left[
 k_{in}I_x^{rain}(1-F_{x,t})
-k_{out}D_xF_{x,t}
\right],
0,1
\right).
\]

Interpretation:

- rainfall fills quickly when dry;
- saturation slows as \(F\to1\);
- drainage causes gradual recovery;
- flooding persists after rainfall stops.

This is more natural than setting flood level equal to instantaneous rain intensity.

---

## 21. Rain/flood impact on roads

Empirical traffic studies consistently report reduced free-flow speed and capacity under rain, with larger reductions under heavier rainfall. Flood-depth studies also support strong nonlinear speed reduction as water depth increases.

### 21.1 Rain-only modifier

For normalized rainfall \(I\):

\[
M_v^{rain}=1-a_v I^{p_v},
\]

\[
M_C^{rain}=1-a_C I^{p_C}.
\]

A starting calibration envelope informed by published rain studies can use approximately:

```text
a_v = 0.10..0.12
 a_C = 0.20..0.33
```

for the most intense synthetic category. The exact values should remain road-class/calibration parameters.

### 21.2 Flood depth mapping

Map normalized flood state to synthetic depth:

\[
h_{cm}=h_{close}\,F,
\]

with `h_close` configurable, e.g. 30 cm.

A published transport-flood model has used

\[
v=v_{max}e^{-0.10814h_{cm}}
\]

until approximately 0.3 m, after which a road can be treated as impassable.

Thus:

\[
M_v^{flood}=e^{-0.10814h_{cm}}.
\]

For strict deterministic mode, implement this as a fixed lookup table indexed by quantized \(F\).

### 21.3 Capacity under flood

Use a steeper function than speed:

\[
M_C^{flood}=(1-F)^{\gamma_F},
\qquad \gamma_F\in[1.5,3].
\]

At

\[
F\ge F_{close}
\]

set effective capacity to zero and mark the edge closed for new route planning.

---

## 22. Natural DWS–traffic coupling

Do not add an arbitrary “rain congestion bonus.” Let the physics couple through speed and capacity.

\[
v_e^{eff}=v_{f,e}
M_v^{rain}
M_v^{flood}
M_v^{manual},
\]

\[
C_e^{eff}=C_{0,e}
M_C^{rain}
M_C^{flood}
M_C^{signal}
M_C^{manual}.
\]

Then

\[
x_e=\frac{Q_e}{C_e^{eff}}
\]

rises automatically when weather reduces capacity. The BPR pressure term rises nonlinearly, SUMO vehicles slow/queue, and measured congestion increases.

This automatically satisfies the requirement that weather has a proportionally larger effect in places already under high traffic pressure.

---

## 23. Combination algebra for independent effects

For normalized adverse effects \(a_i\in[0,1]\), combine with noisy-OR:

\[
A=1-\prod_i(1-a_i).
\]

For multiplicative performance modifiers \(m_i\in[0,1]\), combine as:

\[
M=\prod_i m_i.
\]

Use the first form for “amount of adverse state” and the second for “remaining capacity/speed.” This keeps semantics clear.

---

## 24. Event schedule compilation

All seed-derived events are generated before runtime into immutable logical schedules.

Recommended stacks:

```text
TemporalDemandStack
WeatherEventStack
```

Because a stack is LIFO, compile events in **descending execution time**, then push them. The earliest event is therefore on top.

Canonical event order for equal times:

```text
(start_tick, event_type_priority, target_number, event_id)
```

The schedule itself is immutable. Applied/undone state is tracked separately.

---

## 25. Control-induced day override

Startup precedence:

```text
if config.day is 0 or 1:
    day = config.day
else:
    day = deterministic RNG day selector (5/7 weekday, 2/7 weekend)
```

A runtime control may set `day=0/1`.

To preserve reproducibility semantics:

- do not rewrite past events;
- keep the base schedule immutable;
- recompile only future temporal-demand events into an `override schedule` from the current percentage onward;
- record the command in the control journal;
- undo removes/restores that overlay.

Thus an interactive run is exactly replayable from `seed + control journal`.

---

## 26. Numerical bounds and safety clamps

Recommended hard invariants:

```text
0 <= congestion <= 1
0 <= flood <= 1
0 <= rainfall <= 1
0 <= building_effect <= 1
0 <= simulation_percentage <= 1
60 <= playback_duration <= 1200
1 <= lane_count <= configured_max
0 < speed <= configured_max_speed
0 <= capacity <= configured_max_capacity
node_count <= 50000
```

Every public control command is validated before entering the simulation command queue.

---

## 27. Complexity summary

For \(|V|\le50,000\), \(|E|\) typically on the same order or a small multiple:

| Operation | Expected complexity |
|---|---|
| Road filtering | \(O(V+E)\) |
| CRFG map selection | \(O((V+E)\log V)\) |
| Stable numbering | \(O(V\log V+E\log E)\) |
| Bus initial scan | near \(O(V+E)\) plus truncated distance checks |
| Stop coverage repair | repeated multi-source expansions; bounded by stop count |
| Route probe centrality | \(P\) A* routes |
| A* route | \(O(E\log V)\) worst-case, usually much lower |
| DWS per telemetry/update step | only objects inside active event radii using spatial index |
| API view serialization | \(O(requested\ objects)\) |

A spatial grid/R-tree over node points and edge bounding boxes prevents DWS/building radius updates from scanning all 50,000 nodes every step.

---

## 28. Calibration strategy

The formulas above deliberately separate **structure** from **parameters**.

Calibration tiers:

1. **Synthetic default:** supplied coefficients/ranges.
2. **City calibrated:** observed traffic counts, speeds, signal timings.
3. **Weather calibrated:** local rain-speed/capacity relationship.
4. **Hydrology calibrated:** DEM/drainage/flood depth replacing synthetic susceptibility.

The architecture should therefore store coefficients in versioned JSON configuration rather than compile them into C++ constants.

---

## 29. Reproducibility manifest

Every run persists at minimum:

```json
{
  "global_seed": "...",
  "schema_version": "1.x",
  "algorithm_version": "1.x",
  "road_filter_version": "...",
  "osm_snapshot_hash": "sha256:...",
  "sumo_version": "...",
  "proj_version": "...",
  "typemap_hash": "sha256:...",
  "compiler": "...",
  "build_commit": "...",
  "playback_duration_seconds": 60,
  "day_initial": 0,
  "config_hash": "sha256:...",
  "control_journal_hash": "sha256:..."
}
```

This is the actual definition of a replayable scenario.

---

## 30. Research basis / references

1. **SUMO — OpenStreetMap import.** `netconvert` can import OSM directly; SUMO documents road-class typemaps, road-only modes, WGS84 projection behavior, and recommended network conversion options.  
   https://sumo.dlr.de/docs/Networks/Import/OpenStreetMap.html

2. **SUMO — netconvert.** Supports OSM and SUMO plain node/edge/connection/traffic-light files.  
   https://sumo.dlr.de/docs/netconvert.html

3. **SUMO — Randomness and reproducibility.** Documents deterministic seeds, internal RNG separation, and known projection/platform reproducibility caveats.  
   https://sumo.dlr.de/docs/Simulation/Randomness.html

4. Salmon, Moraes, Dror, Shaw, **“Parallel Random Numbers: As Easy as 1, 2, 3”** / Random123. Counter-based Philox/Threefry design.  
   https://random123.com/

5. **OSM `oneway` semantics.**  
   https://wiki.openstreetmap.org/wiki/Key:oneway

6. **OSM routing tags.**  
   https://wiki.openstreetmap.org/wiki/OSM_tags_for_routing

7. **IRC:124-2017 / BRT Design Guidelines for Indian Cities.** Recommends an average station spacing around 500 m with a broad 300–800 m target range.  
   https://law.resource.org/pub/in/bis/irc/irc.gov.in.124.2017.pdf

8. **US FTA — Stops, Spacing, Location and Design.** Discusses access-vs-travel-time tradeoff and stop siting near trip generators/attractors.  
   https://www.transit.dot.gov/research-innovation/stops-spacing-location-and-design

9. **FHWA — Webster signal timing.** Classical cycle formula and limitations near saturation.  
   https://ops.fhwa.dot.gov/publications/signal_timing/03.htm

10. **FHWA — Traffic Signal Timing Manual, Chapter 6.** Webster optimum cycle formulation.  
    https://ops.fhwa.dot.gov/publications/fhwahop08024/chapter6.htm

11. **FHWA — BPR-style speed/volume-delay discussion.** Notes original BPR parameters `a=0.15`, `b=4` and local calibration needs.  
    https://www.fhwa.dot.gov/Environment/air_quality/conformity/research/sample_methodologies/emismeth07.cfm

12. Lu et al., **Study of Rainfall Impacts on Freeway Traffic Flow Characteristics**, Transportation Research Procedia 25 (2017). Reports increasing speed/capacity reductions with rain intensity.  
    https://www.sciencedirect.com/science/article/pii/S2352146517304738

13. **NHESS — transport-network flood risk methodology.** Includes an exponential vehicle-speed decay with inundation depth and a 0.3 m operational cutoff assumption.  
    https://nhess.copernicus.org/articles/18/2273/2018/nhess-18-2273-2018.html

14. **SUMO Traffic Lights.** Runtime signal control and program modification.  
    https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html

15. **SUMO Libsumo.** C++ in-process API avoiding TraCI socket overhead.  
    https://sumo.dlr.de/docs/Libsumo.html

---

## 31. Recommended baseline constants

These are starting defaults, not immutable truths.

```yaml
playback_duration_s: 60
max_nodes: 50000
virtual_day_seconds: 86400
sumo_step_s: 1.0

bus_stops:
  min_spacing_m: 300
  target_spacing_m: 500
  max_coverage_m: 800
  building_annulus_m: [80, 250]

traffic:
  bpr_alpha: 0.15
  bpr_beta: 4
  hotspot_fraction: [0.002, 0.015]
  demand_bin_virtual_s: 300
  route_probe_count: 512

signals:
  min_spacing_m: 150
  min_cycle_s: 40
  max_cycle_s: 120
  webster_y_cap: 0.90
  yellow_s: 3
  all_red_s: 1

weather:
  frequency_if_rng: [1, 4]
  min_start_gap_playback_s: 5
  flood_close_depth_cm: 30
  flood_close_norm: 0.95
  spatial_kernel: wendland_c2

strict_replay:
  integer_geometry_mm: true
  canonical_sorting: true
  pinned_sumo_proj: true
```

