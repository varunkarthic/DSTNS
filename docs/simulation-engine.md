# Simulation Engine Architecture & State Management

The DSTNS Simulation Engine (`SimulationEngine` in `src/engine.cpp`, `include/dstns/engine.hpp`) provides single-writer, fixed-step dynamic simulation of urban road traffic, signal phases, incidents, weather, and transit operations.

---

## 1. Single-Writer Concurrency Pattern

To ensure lock-free read consistency and eliminate race conditions:
- **Single State Owner**: Only the dedicated simulation thread mutates `GraphStore`, `EdgeDynamic`, `NodeDynamic`, `SignalState`, and bus positions.
- **Synchronized Command Queue**: API and operator control requests (such as road closures, bus dispatches, or signal overrides) push immutable command structs into a thread-safe command queue.
- **Fixed Tick Drainage**: At the start of each physics step, the engine drains and applies pending commands deterministically before updating traffic dynamics.

```text
[HTTP API Threads] ───────> (Thread-Safe Command Queue)
                                       │
                                       v
[Simulation Thread] ───> [Drain Queue] ───> [Physics Step] ───> [Publish Snapshot]
```

---

## 2. Decoupled Three-Clock Model

DSTNS decouples time into three independent coordinate frames:

1. **Playback Wall Clock ($t_P$)**: Real-world elapsed wall time since simulation initialization.
2. **Virtual Day Clock ($t_D$)**: Simulated time of day in seconds from midnight ($t_D \in [0, 86400)$). Progresses at $\Delta t = \text{tick\_rate} \times \Delta t_{\text{wall}}$. Controls diurnal demand curves, morning/evening peaks, and scheduled incidents.
3. **Microscopic Physics Clock ($t_{\text{SUMO}}$)**: Sub-second discretized time ($0.1\text{s} - 1.0\text{s}$) used for vehicle car-following and lane-changing physics in SUMO.

---

## 3. Complete Reset & State Purge Contract

When a simulation is stopped, reset, or re-initialized (`SimulationEngine::reset()`):
All mutable runtime state is purged to prevent cross-simulation contamination:
- `manual_weather_.clear()`: Removes all operator-injected storm cells.
- `active_surges_.clear()`: Purges traffic surge overrides.
- `active_transit_buses_.clear()`: Removes all dispatched buses.
- `signal_overrides_.clear()` & `signal_by_node_.clear()`: Restores baseline signal timings.
- Monotonic ID counters reset:
  - `next_command_id_ = 1`
  - `next_news_id_ = 1`
  - `next_event_id_ = 1'000'000`
- Edge and Node dynamic state vectors re-initialized from baseline static geometry.

This guarantees that running Scenario A, resetting, running Scenario B, resetting, and re-running Scenario A produces the exact same bit-for-bit trajectory.

---

## 4. Physics Step Execution Order

Each tick in `SimulationEngine::physics_step()`:
1. **Command Ingestion**: Processes manual closures, bus dispatches, weather injections.
2. **Incident Evaluation**: Computes active incidents, applies minimum speed/capacity multipliers, sets `incident_closed`.
3. **Signal Phase Updating**: Cycles traffic lights according to green/yellow/red phase timers or manual green holds.
4. **Weather Kinematics**: Advances storm cell positions and evaluates Wendland kernel precipitation across nodes.
5. **Traffic Flow Computation**: Evaluates Bureau of Public Roads (BPR) link performance:
   $$t_e = t_{e,0} \left(1 + \alpha \left(\frac{V_e}{C_e \cdot f_{\text{inc\_cap}}}\right)^\beta\right)$$
   Attenuates speed by weather, flooding, and incident multipliers.
6. **Transit Bus Telemetry**: Advances active buses along contiguous node sequences, updates GPS coordinates and progress fractions.
7. **News & Event Logging**: Generates telemetry notifications for threshold breaches, closures, and recoveries.
