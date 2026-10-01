# Simulation engine

`SimulationEngine` (`include/dstns/engine.hpp`, `src/engine.cpp`) owns a run:
its lifecycle, its virtual clock, the per-second physics, checkpoints and
seeking, operator controls with undo and redo, world regeneration, and every
read view the API serves. This page documents each of those in the order a
run meets them.


## Responsibilities

| Concern | Methods |
|---|---|
| Starting a run | `start`, `start_async`, `prepare`, `install_scenario` |
| Playback | `play`, `pause`, `stop`, `reset`, `seek`, `step`, `set_tick_rate` |
| Physics | `loop`, `step_to`, `physics_step` |
| Time travel | `capture_checkpoint`, `restore_to` |
| Controls | `override_edge`, `toggle_signal`, `trigger_surge`, `add_weather`, `set_day`, `set_module` |
| History | `record`, `apply_command`, `undo`, `redo`, `history` |
| New worlds | `regenerate_world`, `world_status` |
| Backpressure | `report_backpressure`, `note_delivery`, `backpressure` |
| Views | `status`, `topology`, `snapshot`, `nodes`, `edges`, `places`, `place_kinds`, `catalog`, `news`, `scheduled_events`, `global_view`, `manifest` |
| SUMO | `export_sumo`, `sumo_simulate` |
| Shutdown | `request_terminate`, `terminate` |

All state is guarded by one mutex; see [Architecture](architecture.md#threads-and-locking)
for the threads and for why compilation runs outside it.

## Installing a scenario

`install_scenario` replaces everything a previous run left behind, so no state
leaks from one run to the next:

- builds a fresh `GraphStore` from the compiled `Scenario`;
- resets the clock, tick rate, ASB, manual weather, surges, signal overrides,
  news, command history, redo stack and checkpoints;
- restarts the ID counters (commands from 1, news from 1, operator events from
  1,000,000, so they never collide with scheduled event IDs);
- initialises the event runtime (signal heap and demand schedule) and the
  congestion tracker;
- posts the start-of-day news: scenario and seed, topology size, weather
  forecast, signals online, traffic model active;
- captures the checkpoint at 00:00:00;
- seeks to `start_virtual_time` when the start request asked for one.

`run_id` is `run_` followed by 12 hex digits of the scenario hash, so the same
seed and configuration always produce the same `run_id`.

## Lifecycle operations

| Operation | Allowed from | Result | Otherwise |
|---|---|---|---|
| `start` / `start_async` | `IDLE`, `READY`, `STOPPED`, `COMPLETED` | `PREPARING`, then `RUNNING` | 409: a simulation is already active |
| `prepare` | any (stops a running one) | `PREPARING`, then `READY` | 409 if a compile is in flight |
| `play` | `PAUSED`; no-op when `RUNNING` | `RUNNING` | 409 |
| `pause` | `RUNNING`; no-op when `PAUSED` | `PAUSED` | 409 |
| `stop` | any with a world | `STOPPED` | no-op without a world |
| `reset` | any | `IDLE`, world discarded, any in-flight compile cancelled | |
| `seek(t, play)` | any with a world except `TERMINATING`, `PREPARING` | `RUNNING` if it was running or `play` was set, else `PAUSED`; `COMPLETED` at 24:00:00 | 400 if `t > 86400`; 409 otherwise |
| `step(s)` | any with a world except `TERMINATING`, `PREPARING`, and not at 24:00:00 | always `PAUSED`, or `COMPLETED` at 24:00:00 | 400 if `s` outside 1 to 3600; 409 otherwise |

`pause` and `play` accept an optional guard object, which the observer's
tutorial uses so its own pause cannot override the operator's:

| Guard field | Refused with 409 when |
|---|---|
| `expected_run_id` | the run has changed |
| `expected_playback_revision` | anything has changed playback since the guard was taken |
| `require_asb_normal` | ASB is not `NORMAL` |

`playback_revision` increments on every lifecycle transition, and an
unguarded pause of an already paused run also increments it, so an explicit
operator pause supersedes any outstanding guarded request.

## Advancing time

The engine loop wakes every 50 ms. While `RUNNING`, it computes where the
clock should be from the wall-clock anchor and calls `step_to(target)`:

\[
r = \frac{86400}{T_P}\,k \quad \text{virtual seconds per wall second}, \qquad
t_{\text{target}} = \min\Big(86400,\; t_{\text{anchor}} + \big\lfloor (\text{now} - w_{\text{anchor}})\, r \big\rfloor\Big)
\]

where \( T_P \) is the playback duration, \( k \) the applied tick rate, and
\( (t_{\text{anchor}}, w_{\text{anchor}}) \) the virtual and wall times at the last
play, pause, seek or rate change.

```cpp
const auto elapsed = std::chrono::duration<double>(now - anchor_wall_).count();
const auto rate    = day_s / double(playback_duration_s) * tick_rate_;
step_to(std::min(day_s, anchor_virtual_s_ + static_cast<std::uint32_t>(elapsed * rate)));
```

The target is recomputed from the **anchor** each wake rather than accumulated from
the previous tick, so rounding down to a whole second never accumulates error: the
fractional part is simply recomputed next time. A loop that wakes late (a busy
machine) still lands on the right virtual time.

`step_to` advances one virtual second at a time, calling `physics_step(1)`
each time and capturing a checkpoint at every multiple of 900 s. Reaching
86,400 while `RUNNING` transitions to `COMPLETED`.

```cpp
void SimulationEngine::step_to(std::uint32_t target) {
    target = std::min(target, day_s);
    while (virtual_s_ < target) {
        const auto to_checkpoint = 900 - (virtual_s_ % 900);
        const auto dt = std::min({std::uint32_t{1}, target - virtual_s_, to_checkpoint});
        virtual_s_ += dt;
        physics_step(dt);
        if (virtual_s_ % 900 == 0) capture_checkpoint();      // exactly on each 900 s boundary
    }
    if (virtual_s_ >= day_s && lifecycle_ == Lifecycle::Running) transition(Lifecycle::Completed);
}
```

The step is always 1 s here; the `to_checkpoint` term exists so that a step can never
straddle a checkpoint boundary even if the step size were ever changed.

### Worked example: a clock

A one-hour day (\( T_P = 3600 \)) at \( k = 2 \):

\[
r = \frac{86400}{3600} \cdot 2 = 48\ \text{virtual s per wall s}
\]

A whole day then takes \( 86400 / 48 = 1800 \) s, thirty minutes. The loop wakes every
50 ms, so each wake covers \( 48 \times 0.05 = 2.4 \) virtual seconds: two or three
whole steps. After 7.5 wall seconds the target is
\( \lfloor 7.5 \times 48 \rfloor = 360 \) seconds past the anchor, which is 00:06:00.

### Worked example: a seek

Checkpoints sit at multiples of 900 s, so a target \( t \) restores checkpoint
\( \lfloor t / 900 \rfloor \) and replays \( t \bmod 900 \) steps:

\[
n_{\text{replay}} = t \bmod 900 \in [0, 899], \qquad
T_{\text{seek}} \approx n_{\text{replay}}\, T_{\text{step}}
\]

| Seek to | \( t \) | Checkpoint | Replay | Cost at 0.27 ms/step |
|---|---|---|---|---|
| 08:00:00 | 28,800 | 32 (at 28,800) | 0 | restore only |
| 08:07:30 | 29,250 | 32 | 450 | 0.12 s |
| 08:14:59 | 29,699 | 32 | 899 | 0.24 s (worst case) |

Going *forward* needs no restore: the engine just simulates the difference.

`catch_up_to_wall_clock()` runs before anything that changes the rate (a rate
request, its undo or redo, an ASB rate cap), so time already elapsed at the
old rate is credited at the old rate.

## The physics step

`physics_step(dt)` runs the same sequence every virtual second. The model is
aggregate (flows and queues per directed edge), not microscopic; SUMO is the
separate microscopic adapter.

### Weather and flooding

Each scheduled or manual storm (`DwsEvent`) has a start, end, epicentre,
radius and intensity. At normalised phase `p` through its life:

| Phase | Radius multiplier | Intensity multiplier |
|---|---|---|
| `p < 0.25` (growth) | `0.20 + 0.80 sin(2πp)` | `sin(2πp)` |
| `0.25 ≤ p ≤ 0.70` (plateau) | 1 | 1 |
| `p > 0.70` (decay) | `1 − 0.65 t²`, where `t = (p − 0.70)/0.30` | `cos(πt/2)` |

The epicentre drifts up to 30% of the radius along a per-storm wind direction.
Rain at a node combines every active storm as independent probabilities,

```
rain = 1 − Π (1 − intensity_k × W(d_k, r_k))
```

where `W` is the compactly supported Wendland C² kernel
`(1 − q)⁴ (1 + 4q)` for `q = d/r < 1`. With flooding enabled, each node's
flood level integrates

```
flood += dt × (0.018 × rain × flood_susceptibility − 0.004 × drainage × flood)
```

clamped to [0, 1]. Edges take the mean of their endpoints' rain and flood. An
edge whose flood crosses 0.01 records a flooding event in the history.

### Incidents

Every incident's speed and capacity multipliers apply while
`start ≤ t < end`. Overlapping incidents compose by taking the minimum
multiplier, and any closing incident closes the edge. Activation and
resolution post news at the scheduled times. See [Incidents](incidents.md).

### Demand

```
demand_vph = base_capacity_vph × (0.18 + 0.68 × day_profile + 0.60 × attraction + 0.35 × hotspot) × surge
day_profile = 0.5 + 0.5 × sin(2π t/86400 − 1.2)
```

`attraction` is the place-driven demand effect from the event runtime (when
the buildings module is on), and `hotspot` is the edge's seeded hotspot
susceptibility (when traffic is on). `surge` is the largest active surge
covering either endpoint; a surge follows `1 + (factor − 1) sin²(π r)` over
its normalised life `r`, and its radius breathes from 35% to 100%. Edges whose
direction is forbidden by a one-way restriction carry nothing.

### Signals

The event runtime keeps one pending transition per controller in a binary
heap, so advancing signals costs O(log n) per transition rather than a scan of
every controller each second. `signal_multiplier` is 1 for green approaches
and small for red ones. A manual override forces the north-south or east-west
group green (multiplier 1.0 versus 0.08) until it is undone.

### Speed, capacity and queues

```
target_speed = closed ? 0 : free_speed × signal × rain × flood × manual × incident
rain speed      = 1 − 0.18 × rain          rain capacity  = 1 − 0.15 × rain
flood speed     = max(0.35, 1 − 0.55 × flood)   flood capacity = max(0.30, 1 − 0.60 × flood)
```

An edge is closed when an operator closed it, an incident closed it, or its
flood level reaches 0.98. Speed approaches its target at no more than
2.4 m/s² accelerating and 3.2 m/s² braking, so speeds change gradually rather
than jumping. The vehicle load approaches a target queue

```
baseline = demand_vph / max(2, free_speed_kmh) × length_km
target   = closed ? 0 : clamp(baseline × (1 + 3.5 (1 − signal)(0.5 + 0.5 surge)), 0, length/7.5 × lanes)
```

filling at the inflow rate (at least 0.4 vehicles/s) and draining at the
saturation rate (at least 0.7 vehicles/s), so queues build and clear smoothly.
From the load the engine derives vehicle and halting counts, mean speed,
occupancy and two congestion measures.

### Congestion

Per edge, `congestion = closed ? 1 : 0.60 × speed_loss + 0.25 × queue_ratio + 0.15 × occupancy`.
The network figure the interface shows comes from `CongestionTracker`: a mean
over traversable edges weighted by length times lanes, reported together with an
exponential moving average (time constant 900 virtual seconds) and sampled every
virtual minute into the history. See [Congestion and road state](congestion.md)
and the [Mathematical model](mathematical-model.md#congestion).

### News

News items carry a category, severity, template ID, message and structured
data, stamped with the virtual time they describe. Disabling the news module
stops new items being posted. The feed is truncated with the rest of the state
when seeking backwards, and its IDs restart from the checkpoint, which is why
the observer resets its cursor whenever the clock moves backwards.

## Checkpoints and seeking

A checkpoint stores the node and edge dynamic arrays, the event runtime, the
congestion tracker and the news length and next ID. One is captured at
00:00:00 and every 900 virtual seconds after.

- **Forward seek or step**: run `step_to(target)`, exactly as playback would.
- **Backward seek**: find the last checkpoint at or before the target, restore
  it, drop the checkpoints after it, then `step_to(target)`.

Physics is deterministic and runs in fixed one-second steps, so seeking to a
time and playing to it produce identical state. `dstns_world_tests` and the
replay suite assert this.

Operator controls are not part of a checkpoint. Signal overrides, surges and
manual rain live outside the dynamic arrays, and edge overrides (manual speed
and capacity multipliers and closures) are carried across a restore
explicitly. An override therefore stands until it is undone, whichever way the
operator moves through time.

## Operator controls

Every control validates its input, applies immediately, increments
`config_revision`, records a command for undo (except surges), and posts news.

| Control | Parameters and bounds | Effect |
|---|---|---|
| `override_edge` | speed and capacity multipliers in [0, 2], `closed` | Manual channel on one directed edge |
| `toggle_signal` | any node (it has an effect only where approaches meet); optional forced phase 1 or 2 | Forces the north-south or east-west approaches green |
| `trigger_surge` | node, factor in (0, 10], radius in (0, 20000] m, duration in [1, 86400] s, ending at midnight at the latest | Demand surge around a node |
| `add_weather` | epicentre node, intensity in [0, 1], radius > 0, duration in [1, 1440] virtual minutes, flood gain in [0, 1] | Manual storm, scheduled at least 5 playback seconds after the previous manual storm |
| `set_day` | 0 (weekday) or 1 (weekend) | Rebuilds the demand schedule for the day type |
| `set_module` | `traffic`, `signals`, `buildings`, `dws`, `flooding`, `news` | Enables or disables a subsystem |
| `set_tick_rate` | (0, 5] | Requested rate; ASB may hold the applied rate lower |

## Undo and redo

`record` pushes `{id, type, before, after}` and clears the redo stack.
`undo(n)` pops up to `n` commands and applies each one's `before`; `redo(n)`
re-applies `after`.

| Command type | Undo restores |
|---|---|
| `tick_rate` | The previous requested rate (catching up to the wall clock first) |
| `day` | The previous day type, re-initialising the demand schedule |
| `module` | The module's previous state |
| `edge_override` | The edge's previous manual multipliers and closure |
| `signal_toggle` | The previous forced phase, or the controller's own timing plan when there was no override |
| `manual_weather` | Intensity 0, so the storm stays scheduled but has no effect |

Undo is logical, not a replay. It restores the control's value from now on;
it does not rewind the effect the control had while it was in force.

## World regeneration

`regenerate_world` takes the compile lease, pauses the current world, copies
its configuration (restoring `osm_file: "auto"` for a seed-selected map so the
new seed picks its own district), and compiles a world from a fresh secure
64-bit seed on the world worker. On success it installs the new world `PAUSED`
at 00:00:00. On failure the job reports `MAP_FETCH_FAILED` or
`WORLD_GENERATION_FAILED` and the old world is untouched. A reset or another
run during the compile bumps the compile generation, and the finished world is
then discarded with `WORLD_CANCELLED`. Progress is published through
`world_status`, including live download bytes. See
[API: world regeneration](../api/reference.md#world-regeneration).

## Backpressure

The observer reports its lag, frame time and polling interval once a second.
`report_backpressure` validates them (finite and non-negative), feeds them to
`AdaptiveBackpressure`, and applies whatever rate cap ASB now allows, without
losing the operator's requested rate. Reports are ignored, and the window
cleared, while a world is being prepared and for 3 s after one is installed,
because lag measured across a world swap describes the world that has gone.
Delivered snapshot sizes are recorded to report throughput. See [ASB](backpressure.md).

## Read views

Every view takes the mutex once and builds its JSON from one consistent state,
inside the standard envelope:

```json
{
  "ok": true, "api_version": "1.0", "run_id": "run_3fa2…", "seed": "382923",
  "global_seed": "0x…", "state_revision": 1834, "config_revision": 3,
  "clock": { "playback_state": "RUNNING", "virtual_day_seconds": 29120,
             "simulated_current_time": "08:05:20", "simulation_percentage": 0.337,
             "playback_duration_seconds": 3600, "base_rate": 24, "tick_rate": 1,
             "target_virtual_rate": 24 },
  "data": { }
}
```

`snapshot` is what the observer polls: per-node rain and flood; per-edge
congestion, speed, counts, closures, multipliers, demand and its causes;
signal states; demand; congestion; active storms, surges and incidents; and the
last 25 news items. `topology` is fetched once per run. `global_view` combines
both with the reproducibility manifest and is written to
`logs/global_view.json` every 10 s.

## Termination

`request_terminate` is lock-free: it sets a flag, kills the downloader's
process group, and wakes the loop, so quitting never waits behind a map
download that holds the mutex. The HTTP layer stops the listener 150 ms later,
and a detached 3 s backstop exits the process in any case. The destructor
joins the loop and world worker before members are destroyed.

## Invariants and their tests

| Invariant | Test |
|---|---|
| Seek and step to the same time give identical state | `dstns_world_tests`, `dstns_rep_tests` |
| A step always leaves the run paused; reaching 24:00:00 completes it | `dstns_world_tests` |
| Seeking to 24:00:00 completes the run | `dstns_world_tests` |
| Operator edge overrides survive a backwards seek and are removed by undo | `dstns_world_tests` |
| Undoing a signal toggle restores the timing plan; redo re-applies it | `dstns_world_tests` |
| Surge and weather parameters are bounded; late surges end at midnight | `dstns_world_tests` |
| A failed regeneration leaves the previous world unchanged | `dstns_world_tests` |
| Reset leaks nothing into the next run | `dstns_tests` |
| Congestion, rain, flood and speed stay within bounds | `dstns_prop_tests` |
| Two independent engines with the same seed agree exactly | `dstns_rep_tests`, `dstns_replay_verify` |
