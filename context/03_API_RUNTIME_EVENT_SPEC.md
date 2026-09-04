# SUMO Deterministic Sandbox — API, Runtime, Event and News Specification

**Document:** 03/03  
**Purpose:** Define the JSON API classes (`view`, `news`, `control`), deterministic event scheduling, news templates, playback semantics, manual-event overlays, day control, undo/redo, schemas, and run-state behavior.

---

## 1. API principles

The API is divided into exactly three semantic classes:

1. **View** — read-only raw/canonical map and live state.
2. **News** — structured and human-readable event notifications.
3. **Control** — state-changing commands.

All public payloads are JSON.

Recommended base path:

```text
/api/v1/
```

The API version is separate from the algorithm version.

---

## 2. Common response envelope

Every response should carry run/revision context.

```json
{
  "api_version": "1.0",
  "run_id": "run_8d8f...",
  "global_seed": "0x7f...",
  "state_revision": 1842,
  "clock": {
    "playback_state": "playing",
    "playback_elapsed_seconds": 17.500,
    "playback_duration_seconds": 60,
    "simulation_percentage": 0.291667,
    "simulated_current_time": "07:00:00",
    "virtual_day_seconds": 25200
  },
  "data": {}
}
```

`state_revision` increments only after a coherent simulation state commit.

---

## 3. Error envelope

```json
{
  "api_version": "1.0",
  "run_id": "...",
  "error": {
    "code": "CONTROL_INVALID_DAY",
    "message": "day must be 0 or 1",
    "details": {
      "received": 3
    }
  }
}
```

Do not return raw C++ exceptions or SUMO stack traces to normal clients.

---

# PART A — VIEW API

## 4. `view` responsibility

`view` exposes:

- graph metadata;
- all canonical nodes and edges;
- raw source provenance;
- static parameters;
- dynamic state;
- bus stops;
- synthetic buildings;
- signals;
- active DWS events;
- traffic metrics;
- resolved run configuration;
- reproducibility manifest.

It is strictly read-only.

---

## 5. View endpoints

Suggested endpoints:

```text
GET /api/v1/view/run
GET /api/v1/view/network
GET /api/v1/view/nodes
GET /api/v1/view/nodes/{node_id}
GET /api/v1/view/edges
GET /api/v1/view/edges/{edge_id}
GET /api/v1/view/bus-stops
GET /api/v1/view/buildings
GET /api/v1/view/signals
GET /api/v1/view/weather
GET /api/v1/view/traffic
GET /api/v1/view/events
GET /api/v1/view/manifest
WS  /api/v1/view/stream
```

Large graph endpoints must support pagination/filtering.

---

## 6. `GET /view/run`

```json
{
  "data": {
    "status": "running",
    "day": 0,
    "day_name": "weekday",
    "modules": {
      "traffic_demand": true,
      "traffic_signals": true,
      "traffic_hotspots": true,
      "buildings": true,
      "dws": true,
      "flooding": true,
      "news": true
    },
    "network": {
      "node_count": 48231,
      "edge_count": 104502,
      "bus_stop_count": 121,
      "signal_count": 386,
      "building_count": 204
    }
  }
}
```

---

## 7. Node JSON schema

```json
{
  "id": 1724,
  "osm_node_id": 9912345678,
  "position": {
    "lat": 23.0123456,
    "lon": 72.5123456,
    "x_m": 4821.124,
    "y_m": 914.303
  },
  "degree": 4,
  "roles": ["traffic_light", "building"],
  "building": {
    "type": "office",
    "impact": 0.64,
    "radius_m": 410.0,
    "tmax": [
      {"start": 0.3125, "end": 0.416667},
      {"start": 0.6875, "end": 0.8125}
    ],
    "current_effect": 0.382
  },
  "weather": {
    "rainfall": 0.18,
    "flood": 0.07,
    "flood_susceptibility": 0.42,
    "drainage": 0.66
  },
  "state_revision": 1842
}
```

If no building exists, `building` should be `null`, not an object filled with zeros.

---

## 8. Edge JSON schema

```json
{
  "id": 6401,
  "from": 1724,
  "to": 1725,
  "reverse_twin": 6402,
  "source": {
    "osm_way_id": 55112233,
    "segment_index": 2,
    "source_oneway": true,
    "source_oneway_direction": 1,
    "synthetic_reverse": false
  },
  "road": {
    "class": "secondary",
    "lanes": 2,
    "length_m": 182.421,
    "free_speed_mps": 13.889,
    "base_capacity_vph": 3400.0
  },
  "traffic": {
    "demand_vph": 2880.2,
    "effective_capacity_vph": 2601.7,
    "effective_speed_mps": 11.62,
    "hotspot_susceptibility": 0.73,
    "vehicle_count": 24,
    "halting_count": 7,
    "mean_speed_mps": 6.91,
    "occupancy": 0.62,
    "congestion_model": 0.58,
    "congestion_observed": 0.67,
    "congestion": 0.63
  },
  "weather": {
    "rainfall": 0.44,
    "flood": 0.21
  },
  "control": {
    "manual_speed_multiplier": 1.0,
    "manual_capacity_multiplier": 1.0,
    "closed": false
  },
  "state_revision": 1842
}
```

---

## 9. Raw graph download

For full raw network export:

```text
GET /api/v1/view/network?format=canonical-json
```

Response:

```json
{
  "data": {
    "root_node": 381,
    "nodes": [...],
    "edges": [...],
    "adjacency": "omitted_by_default"
  }
}
```

For 50k nodes, return gzip/HTTP compression and provide pagination or a binary export endpoint in a later version. The JSON API remains the canonical public schema.

---

## 10. View filters

Examples:

```text
/view/nodes?role=bus_stop
/view/nodes?role=building&type=school
/view/edges?min_congestion=0.7
/view/edges?flooded=true
/view/edges?bbox=x1,y1,x2,y2
/view/edges?road_class=primary,secondary
/view/weather?active=true
```

Filtering happens against one published state revision.

---

# PART B — NEWS API

## 11. News model

News is **derived output**. It must never alter simulation state.

Each news item has:

```cpp
struct NewsItem {
    uint64_t news_id;
    EventId source_event_id;
    uint32_t virtual_day_s;
    NewsSeverity severity;
    NewsCategory category;
    std::string template_id;
    std::string message;
    StructuredNewsData data;
};
```

---

## 12. News endpoints

```text
GET /api/v1/news
GET /api/v1/news/{news_id}
WS  /api/v1/news/stream
```

Query parameters:

```text
since_news_id
since_virtual_time
category
severity
limit
```

---

## 13. News response

```json
{
  "data": {
    "items": [
      {
        "news_id": 553,
        "event_id": 1021,
        "simulated_current_time": "07:18:00",
        "category": "traffic",
        "severity": "info",
        "template_id": "SCHOOL_CONGESTION_INCREASED",
        "message": "[07:18:00] School Time: Congestion Increased at Node 1724 (Radius = 420 m)",
        "data": {
          "target_type": "node",
          "target_id": 1724,
          "radius_m": 420,
          "effect": 0.61
        }
      }
    ]
  }
}
```

The message is convenient for humans; clients should use structured `data` for logic.

---

## 14. News template catalog

Templates are versioned data, e.g. `news_templates.json`.

### General event

```text
EVENT_STARTED
"[{time}] {event_name} was started at {target_type} {target_id}"
```

### DWS

```text
DWS_RAIN_STARTED
"[{time}] Rain Event started at Node {epicenter} (Radius = {radius_m} m, Intensity = {intensity_pct}%)"

DWS_RAIN_PEAK
"[{time}] Rain intensity peaked around Node {epicenter} ({intensity_pct}%)"

DWS_FLOOD_INCREASED
"[{time}] Flooding increased at {target_type} {target_id} (Flood = {flood_pct}%)"

DWS_ROAD_CLOSED
"[{time}] Edge {edge_id} was closed due to flooding (Flood = {flood_pct}%)"

DWS_RAIN_ENDED
"[{time}] Rain Event ended at Node {epicenter}; residual flooding may remain"
```

### Buildings / traffic demand

```text
SCHOOL_CONGESTION_INCREASED
"[{time}] School Time: Congestion Increased at Node {node_id} (Radius = {radius_m} m)"

OFFICE_CONGESTION_INCREASED
"[{time}] Office Peak: Congestion Increased at Node {node_id} (Radius = {radius_m} m)"

MALL_ACTIVITY_INCREASED
"[{time}] Mall Activity Increased at Node {node_id} (Radius = {radius_m} m)"

STORE_ACTIVITY_INCREASED
"[{time}] Retail Activity Increased at Node {node_id} (Radius = {radius_m} m)"
```

### Traffic signals

```text
SIGNAL_PLAN_CHANGED
"[{time}] Traffic Signal Plan changed at Node {node_id} (Cycle = {cycle_s} s)"
```

### Control

```text
DAY_CHANGED
"[{time}] Day mode changed to {weekday_or_weekend}"

MODULE_DISABLED
"[{time}] Module {module} was disabled"

MODULE_ENABLED
"[{time}] Module {module} was enabled"

MANUAL_EVENT_APPLIED
"[{time}] Custom {event_name} applied at {target_type} {target_id}"

EVENT_UNDONE
"[{time}] Event/Command {command_id} was undone"

EVENT_REDONE
"[{time}] Event/Command {command_id} was redone"
```

---

## 15. News de-duplication/hysteresis

Dynamic metrics such as flood/congestion can oscillate around a threshold. Do not emit a new message every tick.

Use hysteresis:

```text
enter congested state at C >= 0.70
leave congested state at C <= 0.60
```

and per-target cooldowns in virtual time.

For level changes, optionally quantize into severity bands:

```text
0.00-0.25 low
0.25-0.50 moderate
0.50-0.75 high
0.75-1.00 severe
```

Emit only when the band changes or a semantic event starts/ends.

---

# PART C — CONTROL API

## 16. Control responsibility

Control can modify runtime state through validated commands:

- play/pause;
- day weekday/weekend;
- module enable/disable;
- manual DWS event;
- manual traffic/congestion event;
- edge speed/capacity override;
- event undo/redo;
- optionally signal-plan override.

Control cannot mutate canonical topology in V1.

---

## 17. Control endpoints

Suggested shape:

```text
POST /api/v1/control/play
POST /api/v1/control/pause
POST /api/v1/control/day
POST /api/v1/control/modules/{module}/enable
POST /api/v1/control/modules/{module}/disable
POST /api/v1/control/events/weather
POST /api/v1/control/events/traffic
POST /api/v1/control/edges/{edge_id}/override
POST /api/v1/control/signals/{node_id}/override
POST /api/v1/control/undo
POST /api/v1/control/redo
GET  /api/v1/control/history
```

Every POST returns a `command_id`.

---

## 18. Play

`POST /control/play`

```json
{}
```

Response:

```json
{
  "data": {
    "command_id": 881,
    "playback_state": "playing"
  }
}
```

If already playing, return success with `changed=false` rather than duplicating state mutation.

---

## 19. Pause

`POST /control/pause`

Pause means:

- playback target stops advancing;
- SUMO physics stepping stops after the current safe step;
- API reads continue;
- control commands can still be accepted;
- seed-derived schedule times do not advance while paused.

---

## 20. Day override

`POST /control/day`

```json
{
  "day": 1
}
```

Semantics:

```text
0 = weekday
1 = weekend
```

Response includes whether future demand overlay was recompiled:

```json
{
  "data": {
    "command_id": 901,
    "previous_day": 0,
    "day": 1,
    "future_schedule_overlay_revision": 4
  }
}
```

Changing day is deterministic because it is logged as a control command.

---

## 21. Module control

`POST /control/modules/dws/disable`

```json
{}
```

When disabled:

- no new DWS event effects are applied;
- active DWS rainfall contribution decays/removes according to module policy;
- flooding can either continue draining (recommended) or freeze only if explicitly configured;
- base DWS schedule remains immutable;
- suppressed future events are marked in runtime event history.

Recommended: disabling `dws` stops new rainfall, while `flooding` continues drainage unless flooding itself is separately disabled.

---

## 22. Manual weather event

`POST /control/events/weather`

```json
{
  "epicenter_node": 1724,
  "intensity": 0.82,
  "radius_m": 1800,
  "duration_virtual_minutes": 55,
  "flood_gain": 0.75
}
```

The event:

- is **not inserted** into the immutable seed-derived WeatherEventStack;
- is assigned a command/event ID;
- is an overlay;
- is subject to the five-playback-second DWS admission gate;
- can be logically undone/redone;
- is stored in the control journal.

Response:

```json
{
  "data": {
    "command_id": 921,
    "event_id": 4501,
    "status": "scheduled",
    "requested_start_playback_s": 14.2,
    "effective_start_playback_s": 16.0,
    "delayed_by_dws_gate": true
  }
}
```

---

## 23. Manual traffic event

`POST /control/events/traffic`

```json
{
  "target": {
    "type": "edge",
    "id": 6401
  },
  "congestion_pressure": 0.75,
  "radius_m": 500,
  "duration_virtual_minutes": 35
}
```

Traffic events do **not** use the DWS five-second gate.

A traffic event should preferably alter demand/capacity pressure rather than directly freezing vehicles.

Possible modes:

```text
DEMAND_MULTIPLIER
CAPACITY_MULTIPLIER
SPEED_MULTIPLIER
HOTSPOT_OVERLAY
```

Explicitly identify the mode in production requests.

---

## 24. Direct edge override

`POST /control/edges/{edge_id}/override`

```json
{
  "speed_multiplier": 0.65,
  "capacity_multiplier": 0.80,
  "closed": false,
  "duration_virtual_minutes": 20
}
```

Validation:

```text
0 <= speed_multiplier <= 2.0
0 <= capacity_multiplier <= 2.0
```

The default safe policy should disallow setting an effective speed above a configured sandbox maximum.

---

## 25. Signal override

`POST /control/signals/{node_id}/override`

```json
{
  "mode": "phase_duration",
  "phase_index": 0,
  "remaining_duration_s": 28
}
```

or:

```json
{
  "mode": "program",
  "program_id": "peak_evening"
}
```

SUMO supports runtime phase/program/phase-duration changes through TraCI/libsumo-compatible traffic-light APIs.

Signal commands should be validated against the junction's compiled signal plan.

---

## 26. Undo

`POST /control/undo`

```json
{
  "count": 1
}
```

Response:

```json
{
  "data": {
    "undone": [921],
    "undo_depth": 14,
    "redo_depth": 1
  }
}
```

Undo semantics in V1 are **logical effect reversal**:

- restore changed parameters/state overlays;
- do not rewind time;
- do not reverse vehicle movement that already happened.

For DWS, undoing an active manual weather overlay removes its future rainfall contribution. If the command snapshot includes flood deltas, its direct sandbox flood overlay can be restored, but already-realized vehicle trajectories remain historical.

---

## 27. Redo

`POST /control/redo`

```json
{
  "count": 1
}
```

Redo applies the previously stored `after` mutation values.

Submitting a new control mutation after undo clears the redo stack, following conventional history semantics.

---

## 28. Control history

`GET /control/history`

```json
{
  "data": {
    "commands": [
      {
        "command_id": 901,
        "type": "set_day",
        "applied_at": "12:10:00",
        "status": "applied",
        "undoable": true
      },
      {
        "command_id": 921,
        "type": "manual_weather",
        "applied_at": "12:14:24",
        "status": "undone",
        "undoable": true
      }
    ]
  }
}
```

---

# PART D — EVENT SCHEDULING

## 29. Base deterministic event classes

### Temporal stack

Contains semantic transitions such as:

```text
Building demand window rise/peak/fall markers
Signal plan changes
Day-derived demand regime changes
Traffic hotspot regime markers
```

### Weather stack

Contains:

```text
DWS event start
DWS event end
optional severity/news milestones
```

The continuous weather/flood field itself is computed each physics step; the stack activates/deactivates event definitions.

---

## 30. Stack representation

A normal vector is sufficient and faster than `std::stack` while retaining stack semantics.

```cpp
class DeterministicEventStack {
public:
    const ScheduledEvent* peek() const;
    ScheduledEvent pop();
    bool empty() const;
private:
    std::vector<ScheduledEvent> events_;
};
```

Compile sorting order:

```text
execution_time DESC
then type_priority DESC
then target_id DESC
then event_id DESC
```

Push in that order. Runtime `back()` is earliest event.

This provides O(1) pop and cache-friendly storage.

---

## 31. Runtime event admission

At each virtual physics step:

```text
while temporal_stack.peek.time <= current_time:
    execute(pop)

while weather_stack.peek.time <= current_time:
    execute(pop)
```

Equal-time event priority should be explicit. Recommended high-to-low:

```text
1. Module enable/disable overlay
2. Day regime change
3. Weather end
4. Weather start
5. Signal plan change
6. Demand regime marker
7. Pure news marker
```

Manual commands are applied at the safe-point before the next physics step and recorded separately.

---

## 32. DWS deterministic schedule generation

Given playback duration \(T_P\) and frequency \(F\):

1. validate `(F-1)*5 < T_P`;
2. generate keyed uniforms `u[event_id, START_POSITION]`;
3. stable sort them;
4. compute:

\[
S=T_P-5(F-1),
\]

\[
t_i=5i+S u_{(i)};
\]

5. convert to normalized percentage `p_i=t_i/T_P`;
6. generate duration in virtual time;
7. choose epicenter node;
8. choose radius/intensity;
9. compile start/end events.

No runtime RNG is needed.

---

## 33. DWS event radius

Use map-relative bounds so the same algorithm works in small and large selected regions.

Let \(D_{map}\) be the diagonal of the canonical graph bounding box.

```text
R_min = max(config.absolute_min_radius, 0.03 * D_map)
R_max = min(config.absolute_max_radius, 0.35 * D_map)
```

Then:

\[
R=R_{min}+(R_{max}-R_{min})u^2.
\]

The square favors localized weather while still permitting broad events.

---

## 34. DWS intensity

Normalized peak intensity:

\[
I_{peak}=I_{min}+(1-I_{min})u^{\gamma_I}.
\]

If `gamma_I > 1`, lighter/moderate events become more common than extreme events.

A practical synthetic default:

```text
I_min = 0.15
gamma_I = 1.7
```

Expose these coefficients in configuration.

---

## 35. DWS duration

Duration should be expressed in **virtual minutes/hours**, not raw playback seconds, because the weather should represent a day-scale phenomenon.

Example bounded mapping:

\[
D_{min}=20\text{ virtual minutes},
\quad
D_{max}=120\text{ virtual minutes},
\]

\[
D=D_{min}+(D_{max}-D_{min})u^2.
\]

Event end is clamped to the end of the virtual day or, if wraparound weather is supported later, split into two deterministic events.

---

## 36. Building event/news scheduling

Continuous building demand does not need a separate event every physics tick.

For each `Tmax` interval compile semantic markers:

```text
WINDOW_START
PEAK_APPROACH
PEAK
PEAK_EXIT
WINDOW_END
```

The mathematical effect is still evaluated continuously by the Beta/binomial kernel.

News can be emitted at `PEAK_APPROACH` or when local congestion crosses a threshold, whichever policy is selected.

---

# PART E — PLAYBACK AND DETERMINISM

## 37. Startup configuration

Example:

```json
{
  "seed": "auto",
  "simulation_time": 60,
  "day": "auto",
  "max_nodes": 50000,
  "modules": {
    "traffic_demand": true,
    "traffic_signals": true,
    "traffic_hotspots": true,
    "buildings": true,
    "dws": true,
    "flooding": true,
    "news": true
  },
  "dws": {
    "frequency": "rng",
    "min_start_gap_playback_seconds": 5
  }
}
```

Validation:

```text
60 <= simulation_time <= 3600
day in {0,1,"auto"}
max_nodes <= 50000
```

---

## 38. Seed resolution response

On startup, always print/store:

```json
{
  "resolved_seed": "0x2b1f...",
  "day_initial": 0,
  "simulation_time": 60,
  "scenario_hash": "sha256:..."
}
```

This makes an auto-seeded run replayable.

---

## 39. Day precedence

```text
startup config day=0 -> weekday regardless of seed
startup config day=1 -> weekend regardless of seed
startup config day=auto -> seed chooses day with configured prior
runtime /control/day -> override from that logical time onward
```

Default prior:

```text
weekday 5/7
weekend 2/7
```

---

## 40. Weekend effect resolution

For building \(b\):

```text
impact_effective = impact_base * weekend_impact_multiplier
radius_effective = radius_base * weekend_radius_multiplier
```

when `day=1`.

School/office multipliers decrease; mall/store multipliers increase.

Traffic demand compilation uses the active day profile.

---

## 41. Determinism levels

### Level 0 — Seeded

Same seed generally gives same scenario.

### Level 1 — Logical deterministic

Same seed/config/OSM/software manifest gives same canonical topology, schedule, IDs and event decisions.

### Level 2 — Replay deterministic

Level 1 + recorded interactive control journal.

### Level 3 — Bitwise/strict replay target

Pinned SUMO/PROJ/build, fixed-point/quantized internal decision values, deterministic math tables, fixed thread counts, canonical serialization.

V1 should target at least Level 2.

---

## 42. Interactive controls and determinism

Interactive input is external information. A seed alone cannot predict what a human will click.

Therefore the correct reproducibility identity is:

\[
R=F(S_G,C,O,V,J)
\]

where:

- \(S_G\): global seed;
- \(C\): resolved configuration;
- \(O\): OSM snapshot;
- \(V\): software/version manifest;
- \(J\): control journal.

Without manual controls, \(J=\emptyset\).

---

# PART F — STATE REVISION AND STREAMING

## 43. View stream

`WS /view/stream`

Client subscription request:

```json
{
  "subscribe": {
    "edges": {
      "bbox": [0, 0, 5000, 5000],
      "fields": ["congestion", "flood", "mean_speed_mps"]
    },
    "nodes": {
      "roles": ["bus_stop", "building"]
    },
    "frequency_hz": 5
  }
}
```

Server delta frame:

```json
{
  "type": "state_delta",
  "state_revision": 1843,
  "clock": {...},
  "edges": [
    {"id": 6401, "congestion": 0.66, "flood": 0.23}
  ]
}
```

---

## 44. News stream

`WS /news/stream`

Server:

```json
{
  "type": "news",
  "news_id": 554,
  "simulated_current_time": "07:20:00",
  "category": "weather",
  "message": "[07:20:00] Rain Event started at Node 4221 (Radius = 1800 m, Intensity = 82%)",
  "data": {...}
}
```

News delivery failure must not affect simulation execution.

---

# PART G — EVENT CONFLICTS

## 45. Overlay composition

Multiple effects on the same edge are not “last write wins.” Store independent contribution channels.

```text
base_speed
rain_speed_multiplier
flood_speed_multiplier
manual_speed_multiplier

base_capacity
signal_capacity_multiplier
rain_capacity_multiplier
flood_capacity_multiplier
manual_capacity_multiplier
```

Effective values:

\[
v^{eff}=v_0M_{rain}M_{flood}M_{manual}
\]

\[
C^{eff}=C_0M_{signal}M_{rain}M_{flood}M_{manual}
\]

Undoing one event removes only its channel/contribution.

---

## 46. Multiple manual events

If several manual overlays of the same channel overlap, represent them individually and combine:

For adverse normalized pressures:

\[
A=1-\prod_i(1-A_i).
\]

For performance multipliers:

\[
M=\prod_iM_i.
\]

Removing one overlay simply removes one factor; no need to reconstruct unrelated event state.

---

## 47. DWS + existing congestion

Weather does not directly add arbitrary congestion points. It modifies capacity/speed, which changes the edge demand/capacity ratio.

If edge is already near capacity:

\[
x=Q/C
\]

and weather reduces capacity to \(C'=mC\), then

\[
x'=\frac{x}{m}.
\]

With BPR exponent \(\beta=4\), even a moderate reduction in \(m\) can sharply increase delay pressure. This gives the desired natural proportional compounding.

---

# PART H — SECURITY/ROBUSTNESS OF CONTROL PLANE

## 48. Input validation

Control values must be finite and bounded. Reject:

```text
NaN
Infinity
negative radii
unknown node/edge IDs
invalid signal phase
invalid day
simulation_time outside bounds
weather frequency impossible under 5s rule
```

Never allow API JSON to pass an unchecked string into a shell invocation of `netconvert` or SUMO.

---

## 49. Idempotency

Support optional `Idempotency-Key` for control POSTs.

If a client retries due to network failure, the same command must not be applied twice.

Store:

```text
(idempotency_key -> command_id -> response)
```

for the run lifetime.

---

## 50. Optimistic revision checks

Optional control request:

```json
{
  "expected_state_revision": 1842,
  "...": "..."
}
```

If current revision differs, return `409 STATE_REVISION_CONFLICT` when the operation is revision-sensitive.

---

# PART I — STARTUP/RUNTIME NEWS EXAMPLES

## 51. Startup sequence

Example news stream:

```text
[00:00:00] Scenario initialized with Seed 0xA92F...
[00:00:00] Road Network loaded (48,231 Nodes, 104,502 Directed Edges)
[00:00:00] 121 Bus Stops generated
[00:00:00] 386 Traffic Signals configured
[00:00:00] Day Mode: Weekday
[00:00:00] Dynamic Weather Simulation scheduled 3 events
[00:00:00] Simulation started
```

Structured categories should still accompany these strings.

---

## 52. Morning peak example

```text
[06:52:00] School demand increased at Node 1724 (Radius = 420 m)
[07:18:00] School Time: Congestion Increased at Node 1724 (Radius = 420 m)
[07:34:00] Office Peak: Congestion Increased at Node 3402 (Radius = 560 m)
[07:41:00] Edge 6401 entered High Congestion (73%)
```

---

## 53. Weather example

```text
[11:06:00] Rain Event started at Node 4221 (Radius = 1800 m, Intensity = 82%)
[11:17:00] Flooding increased at Edge 8820 (Flood = 51%)
[11:24:00] Edge 8820 entered Severe Congestion (81%)
[11:42:00] Rain Event ended at Node 4221; residual flooding may remain
[12:09:00] Flooding at Edge 8820 reduced below Moderate level
```

---

## 54. Weekend mode example

```text
[00:00:00] Day Mode: Weekend
[09:00:00] School demand remains suppressed
[11:12:00] Mall Activity Increased at Node 5011 (Radius = 690 m)
[18:32:00] Retail Activity Increased at Node 7290 (Radius = 350 m)
```

---

# PART J — JSON CONFIGURATION SCHEMA EXAMPLE

## 55. Detailed launch configuration

```json
{
  "schema_version": "1.0",
  "seed": "auto",
  "simulation_time": 60,
  "day": "auto",

  "map": {
    "source": "planet-road-index",
    "max_nodes": 50000,
    "min_nodes": 5000,
    "max_anchor_attempts": 64,
    "min_compactness": 0.10
  },

  "modules": {
    "traffic_demand": true,
    "traffic_signals": true,
    "traffic_hotspots": true,
    "buildings": true,
    "dws": true,
    "flooding": true,
    "news": true
  },

  "bus_stops": {
    "min_spacing_m": 300,
    "target_spacing_m": 500,
    "max_coverage_m": 800,
    "building_annulus_m": [80, 250]
  },

  "traffic": {
    "demand_bin_virtual_s": 300,
    "route_probe_count": 512,
    "bpr_alpha": 0.15,
    "bpr_beta": 4,
    "hotspot_fraction_min": 0.002,
    "hotspot_fraction_max": 0.015
  },

  "signals": {
    "min_spacing_m": 150,
    "min_cycle_s": 40,
    "max_cycle_s": 120,
    "webster_y_cap": 0.90,
    "yellow_s": 3,
    "all_red_s": 1
  },

  "dws": {
    "frequency": "rng",
    "rng_frequency_min": 1,
    "rng_frequency_max": 4,
    "min_start_gap_playback_s": 5,
    "min_duration_virtual_min": 20,
    "max_duration_virtual_min": 120,
    "min_intensity": 0.15,
    "intensity_shape": 1.7,
    "flood_close_norm": 0.95,
    "flood_close_depth_cm": 30
  },

  "telemetry": {
    "publish_hz": 5,
    "news_enabled": true
  }
}
```

---

## 56. Building profile configuration

```json
{
  "school": {
    "tmax": [
      {"start": 0.291667, "end": 0.375000, "rise_power": 3, "fall_power": 3},
      {"start": 0.625000, "end": 0.687500, "rise_power": 3, "fall_power": 3}
    ],
    "impact_range": [0.55, 0.90],
    "radius_m_range": [250, 600],
    "weekend_impact_multiplier": 0.10,
    "weekend_radius_multiplier": 0.80
  },

  "office": {
    "tmax": [
      {"start": 0.312500, "end": 0.416667, "rise_power": 2, "fall_power": 3},
      {"start": 0.687500, "end": 0.812500, "rise_power": 3, "fall_power": 2}
    ],
    "impact_range": [0.45, 0.80],
    "radius_m_range": [300, 750],
    "weekend_impact_multiplier": 0.35,
    "weekend_radius_multiplier": 0.90
  },

  "mall": {
    "tmax": [
      {"start": 0.437500, "end": 0.937500, "rise_power": 1, "fall_power": 1}
    ],
    "impact_range": [0.25, 0.55],
    "radius_m_range": [450, 900],
    "weekend_impact_multiplier": 1.25,
    "weekend_radius_multiplier": 1.15
  },

  "store": {
    "tmax": [
      {"start": 0.354167, "end": 0.895833, "rise_power": 1, "fall_power": 1}
    ],
    "impact_range": [0.10, 0.35],
    "radius_m_range": [150, 450],
    "weekend_impact_multiplier": 1.15,
    "weekend_radius_multiplier": 1.10
  }
}
```

---

# PART K — METRICS

## 57. Run metrics endpoint

`GET /view/traffic`

Suggested aggregate metrics:

```json
{
  "data": {
    "network_congestion_mean": 0.36,
    "network_congestion_p95": 0.78,
    "flooded_edge_count": 381,
    "closed_edge_count": 12,
    "mean_vehicle_speed_mps": 8.82,
    "halting_vehicle_count": 492,
    "active_dws_events": 1,
    "active_building_effects": 73,
    "hotspot_edge_count": 908
  }
}
```

---

## 58. Area-weighted / length-weighted congestion

A plain average gives short alleys the same weight as long arterials. Provide a length-weighted network score:

\[
C_{network}
=\frac{\sum_e L_e C_e}{\sum_e L_e}.
\]

Optionally provide traffic-exposure weighting:

\[
C_{exposure}
=\frac{\sum_e L_e N_e C_e}{\sum_e L_e N_e+\epsilon}.
\]

Both are useful; do not collapse them into one ambiguous number.

---

# PART L — REPLAY ENDPOINTS (OPTIONAL V1.1)

## 59. Scenario identity

```text
GET /view/manifest
```

returns hashes/versions.

Optional later controls:

```text
POST /control/checkpoint
POST /control/load-checkpoint
```

Checkpoint loading is more complicated than logical undo and must restore both SUMO and sandbox state.

---

# PART M — ACCEPTANCE TESTS

## 60. API acceptance tests

### View

- requesting a valid node returns stable ID/provenance;
- pagination cannot mix state revisions inside one page token;
- `view` never changes state revision.

### News

- same base run emits same ordered base news sequence;
- disabling News changes no physics state;
- news template text is generated from structured event data.

### Control

- invalid IDs are rejected before queueing;
- day only accepts 0/1;
- weather command respects 5-second playback gate;
- traffic command bypasses weather gate;
- custom events do not alter base schedule hash;
- undo/redo changes overlay state but not past vehicle trajectories;
- command journal replay reproduces control state transitions.

### Determinism

- same seed/config/OSM hash gives same graph/event hashes;
- changing HTTP request timing without changing command sequence does not alter event ordering;
- changing View polling frequency does not alter simulation.

---

# PART N — FINAL RUNTIME CONTRACT

## 61. What is deterministic?

For a run without manual controls:

```text
Global Seed
+ Resolved Configuration
+ OSM Snapshot
+ Algorithm Version
+ SUMO/Projection Manifest
---------------------------------
= Same map region
  Same canonical nodes/edges
  Same bidirectional conversion
  Same stop nodes
  Same buildings
  Same day selection
  Same traffic hotspots
  Same trip schedule
  Same signal plans
  Same DWS frequency
  Same DWS epicenters/radii/intensities/times
  Same base news events
```

For a run with manual controls, add:

```text
+ Control Journal
```

and the interactive state transitions become replayable as well.

---

## 62. What SUMO is used for

SUMO is treated as the microscopic traffic executor, not the semantic source of randomness/topology.

Runtime integration should use libsumo in C++ where practical. Relevant documented runtime capabilities include:

- changing lane maximum speed;
- controlling traffic-light phase/program/duration;
- retrieving simulated state/telemetry;
- stepping the simulation;
- optional state save/load.

References:

- https://sumo.dlr.de/docs/Libsumo.html
- https://sumo.dlr.de/docs/TraCI/
- https://sumo.dlr.de/docs/TraCI/Change_Lane_State.html
- https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html
- https://sumo.dlr.de/docs/Simulation/SaveAndLoad.html

---

## 63. Recommended V1 endpoint summary

```text
VIEW
  GET /api/v1/view/run
  GET /api/v1/view/network
  GET /api/v1/view/nodes
  GET /api/v1/view/nodes/{id}
  GET /api/v1/view/edges
  GET /api/v1/view/edges/{id}
  GET /api/v1/view/bus-stops
  GET /api/v1/view/buildings
  GET /api/v1/view/signals
  GET /api/v1/view/weather
  GET /api/v1/view/traffic
  GET /api/v1/view/events
  GET /api/v1/view/manifest
  WS  /api/v1/view/stream

NEWS
  GET /api/v1/news
  GET /api/v1/news/{id}
  WS  /api/v1/news/stream

CONTROL
  POST /api/v1/control/play
  POST /api/v1/control/pause
  POST /api/v1/control/day
  POST /api/v1/control/modules/{module}/enable
  POST /api/v1/control/modules/{module}/disable
  POST /api/v1/control/events/weather
  POST /api/v1/control/events/traffic
  POST /api/v1/control/edges/{id}/override
  POST /api/v1/control/signals/{id}/override
  POST /api/v1/control/undo
  POST /api/v1/control/redo
  GET  /api/v1/control/history
```

---

## 64. Core design conclusion

The system should be understood as four deterministic layers:

```text
Layer 1 — Canonical World
  OSM road graph -> DRNCP -> stable bidirectional graph

Layer 2 — Scenario Field
  stops + buildings + hotspots + signals + DWS plan

Layer 3 — Dynamic Physics
  demand + flood reservoirs + effective road parameters + SUMO

Layer 4 — Interaction
  View + News + Control + command journal + undo/redo
```

The seed controls Layers 1–3. Layer 4 remains exactly replayable through its command journal.
