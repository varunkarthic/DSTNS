# Event engine

Source: `EventRuntime` (`include/dstns/events.hpp`, `src/events.cpp`) and the
control side of `SimulationEngine`.

## Two kinds of events

| Kind | Owner | Examples | Recorded in |
|---|---|---|---|
| **Scheduled** | `EventRuntime` | Signal phase changes, place demand changes, storms, incidents, flood crossings | Event queue and history (`/view/event-queue`), news |
| **Operator** | `SimulationEngine` | Edge overrides, signal toggles, manual rain, surges, rate, day, modules | Control history (`/control/history`), SQLite `event_log`, news |

## EventRuntime

```cpp
class EventRuntime {
public:
    void initialize(const Scenario&);                 // build the heap and demand state
    std::vector<ScheduledEvent> advance(const Scenario&, std::uint32_t t);  // execute everything due
    void recouple(const Scenario&, const std::vector<EdgeDynamic>&, std::uint32_t t); // demand couplings
    void observe(ScheduledEvent);                     // record an unscheduled event (flooding)
    nlohmann::json inspect(bool future, const std::string& category, std::size_t offset, std::size_t limit) const;
    double signal_multiplier(const Scenario&, const EdgeStatic&) const;
    double demand_effect(EdgeId) const;
};
```

- The queue is a min-heap on `(time, sequence)`; the sequence number makes the
  order of simultaneous events deterministic.
- History keeps the last 2,000 executed events; `executed_count` counts all.
- `recouple` runs last in every physics step, so demand describes the state
  the operator is about to see.

## Operator commands and undo

Each undoable control records `{id, type, before, after}`:

| `type` | From | Undo restores |
|---|---|---|
| `tick_rate` | `set_tick_rate` | Previous requested rate |
| `day` | `set_day` | Previous day type, rebuilding the schedule |
| `module` | `set_module` | Module's previous state |
| `edge_override` | `override_edge`, `/events/traffic` | Edge's previous multipliers and closure |
| `signal_toggle` | `toggle_signal` | Previous forced phase, or the timing plan |
| `manual_weather` | `add_weather` | Intensity 0 |

Surges are not recorded and cannot be undone. Any new command clears the redo
stack. Undo is logical: it restores the value from now on, not the past.
See [Simulation engine: undo and redo](../concepts/simulation-engine.md#undo-and-redo).
