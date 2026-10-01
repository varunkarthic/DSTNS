# Incidents

An incident is a planned disruption of one directed road segment for a bounded
time: a crash, a breakdown, a spill, a bottleneck or a closure. Incidents are
chosen from the seed when the scenario is compiled, so the same seed always has
the same incidents at the same times on the same roads. This page covers how they
are planned, the probabilities involved, how they act on the traffic model, and
how to observe them.

## Guarantees

| Property | Statement |
|---|---|
| Deterministic | Drawn only from the `incidents` sub-seed; the same seed gives identical incidents |
| Minimum count | At least **4** per day, more for a long playback (see below) |
| Spread across the day | Incidents are assigned to three time bands in rotation, so a day is never all morning |
| Valid targets | Only traversable edges: a one-way road's synthetic reverse is never chosen |
| Composable | Overlapping incidents on one edge combine without clobbering each other |
| Reversible | When an incident ends, any others still active on that edge keep acting |

## Planning

`ScenarioCompiler::plan_incidents` (`src/scenario.cpp`) runs once per compile.

### How many

\[
n \;=\; \max\!\Big( n_{\min},\; \max\!\big(4,\; \lfloor T_P / 600 \rfloor\big) \Big)
\]

where \( T_P \) is the playback duration in seconds and \( n_{\min} \) is
`min_incidents` (default 4). With the default one-hour day, \( n = 6 \); at one
minute, \( n = 4 \).

### When

Incident \( i \) is assigned to a band by \( i \bmod 3 \), so bands rotate and each
gets about a third of the incidents:

| Band | \( i \bmod 3 \) | Fraction of the day | Clock time (24 h) |
|---|---|---|---|
| Early | 0 | \( [0.08,\ 0.35) \) | 01:55 to 08:23 |
| Midday | 1 | \( [0.35,\ 0.65) \) | 08:23 to 15:36 |
| Late | 2 | \( [0.65,\ 0.92) \) | 15:36 to 22:04 |

Within its band \( [a, b) \), the start is uniform, and the duration is 15 to 45
minutes:

\[
t_{\text{start}} = \Big\lfloor 86400\,\big(a + (b - a)\,u\big) \Big\rfloor, \qquad
\Delta = 900 + X, \;\; X \sim \mathcal{U}\{0, \dots, 1800\}, \qquad
t_{\text{end}} = \min\big(86400,\; t_{\text{start}} + \Delta\big)
\]

so \( \mathbb{E}[\Delta] = 1800 \) s (30 minutes). \( u \) is a uniform draw and
\( X \) a bounded draw, both from the incident's own address, so each incident's
time is independent of the others.

### Where and what

The edge is uniform over the eligible edges (those whose direction is allowed),
and the type is uniform over five types:

\[
P(\text{edge} = e) = \frac{1}{|E_{\text{eligible}}|}, \qquad P(\text{type}) = \tfrac15 \text{ each}
\]

```cpp
const auto edge_idx = rng.bounded({RngDomain::Incidents, i, 2, 0}, eligible_edges.size());
const auto type     = static_cast<IncidentType>(rng.bounded({RngDomain::Incidents, i, 3, 0}, 5));
```

Each draw has its own *purpose* number (0 start, 1 duration, 2 edge, 3 type), so the
four quantities of incident \( i \) are independent, and adding a fifth quantity later
would not disturb the existing four.

## Types and effects

| Type | Speed multiplier \( m_v \) | Capacity multiplier \( m_C \) | Closes road | News severity |
|---|---|---|---|---|
| Road closure | 0 | 0 | yes | alert |
| Accident | 0.35 | 0.40 | no | warning |
| Congestion bottleneck | 0.45 | 0.50 | no | info |
| Vehicle breakdown | 0.55 | 0.60 | no | warning |
| Hazard spill | 0.20 | 0.25 | no | alert |

While \( t_{\text{start}} \le t < t_{\text{end}} \) the multipliers enter the traffic
model's target speed and capacity (see [Mathematical
model](mathematical-model.md#speed-and-capacity)):

\[
v^{\text{target}}_e = v^{\text{free}}_e \cdot m^{\text{sig}} \cdots \cdot m^{\text{inc}}_v,
\qquad
C^{\text{eff}}_e = C_e \cdot m^{\text{sig}} \cdots \cdot m^{\text{inc}}_C
\]

### Overlap

Each physics step resets an edge's incident multipliers to 1 and then folds in every
active incident, taking the minimum, so the most severe wins and nothing is
double-counted:

\[
m^{\text{inc}}_v(e, t) = \min_{i \,\in\, \mathcal{A}(e, t)} m_{v,i}, \qquad
\text{closed}(e, t) = \bigvee_{i \,\in\, \mathcal{A}(e, t)} \text{closes}_i
\]

where \( \mathcal{A}(e, t) \) is the set of incidents active on edge \( e \) at time
\( t \).

```cpp
// every physics step
es.incident_speed_multiplier = 1.0;  es.incident_capacity_multiplier = 1.0;  es.incident_closed = false;
for (const auto& inc : sc.incidents) {
    if (virtual_s_ >= inc.start_virtual_s && virtual_s_ < inc.end_virtual_s) {
        es.incident_speed_multiplier    = std::min(es.incident_speed_multiplier,    inc.speed_multiplier);
        es.incident_capacity_multiplier = std::min(es.incident_capacity_multiplier, inc.capacity_multiplier);
        if (inc.closed) es.incident_closed = true;
    }
}
```

Recomputing from scratch every step, rather than undoing an incident when it ends,
is what makes overlap safe: there is no state to restore, and seeking backwards
needs no special handling.

## Probabilities worth knowing

Because the type is uniform and independent, the chance that a day has **no** road
closure at all is

\[
P(\text{no closure}) = \left(\tfrac45\right)^{n}
\]

| \( n \) | Meaning | \( P(\text{no closure}) \) | P(at least one) |
|---|---|---|---|
| 4 | Minimum | 0.410 | 0.590 |
| 6 | One-hour day | 0.262 | 0.738 |

So about three in four default days include a full road closure somewhere.

## Observing incidents

| Where | What |
|---|---|
| `GET /api/v1/view/incidents` | Every incident of the day, with `active` for the current time |
| Snapshot `active_incidents` | Those active now, with the edge's live congestion, speed, `remaining_s` |
| News | `INCIDENT_ACTIVATED` and `INCIDENT_RESOLVED`, at their scheduled times |
| The observer | The **Incidents** list and the road colouring (a closure is drawn closed) |

```bash
curl -s localhost:8090/api/v1/view/incidents | python3 -c '
import json, sys
fmt = lambda s: "%02d:%02d" % (s // 3600, s % 3600 // 60)
for i in json.load(sys.stdin)["data"]["items"]:
    flag = "ACTIVE" if i["active"] else ""
    print(fmt(i["start_virtual_s"]) + "-" + fmt(i["end_virtual_s"]), i["type"].ljust(18), "edge", i["edge_id"], flag)'
```

```text
06:37-07:10 road_closure       edge 137
07:32-08:14 vehicle_breakdown  edge 776
09:01-09:38 congestion         edge 455
17:13-17:39 vehicle_breakdown  edge 150
...
```

Each line is one incident in start order (shown for seed 382923 on the bundled
map). The script converts virtual seconds to `HH:MM` and marks the incidents that
are active at the current time.

An incident record:

```json
{ "incident_id": 3, "type": "accident",
  "description": "Multi-vehicle collision: lane blocked, emergency services on scene",
  "edge_id": 1881, "node_id": 912,
  "start_virtual_s": 30240, "end_virtual_s": 31980,
  "speed_multiplier": 0.35, "capacity_multiplier": 0.40,
  "closed": false, "active": true }
```

## Disabling and testing

Incidents are on by default (`ScenarioConfig::incidents`). They are replayed
identically after any seek, because they are scheduled data and the effect is
recomputed each step. The unit test "incidents minimum count and temporal spread"
(`tests/unit/test_main.cpp`) checks the count and spread guarantees.
