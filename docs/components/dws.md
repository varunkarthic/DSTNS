# DWS: Deterministic Weather Simulation

Source: `ScenarioCompiler::plan_weather` (schedule), `evaluate_storm_state`
and `SimulationEngine::physics_step` (fields), `SimulationEngine::add_weather`
(manual storms).

## A storm

```cpp
struct DwsEvent {
    EventId id;
    NodeId epicenter;
    std::uint32_t start_ppm, end_ppm;   // parts per million of the virtual day
    double intensity;                   // peak, 0..1
    double radius_m;                    // nominal radius
    double flood_gain, recovery;        // recorded; the flood integrator uses fixed rates
};
```

## Scheduling

`dws.frequency` storms per day (default 3), seeded from the `DwsSchedule`
domain:

- Start times are sorted uniform draws over the playback day, with consecutive
  storms at least **5 playback seconds** apart, so manual and scheduled storms
  never land on one instant.
- Duration \( 45 + 75 u^{1.5} \) virtual minutes (45 to 120).
- Epicentre: a seeded node. Radius: 100 to 600 m. Intensity
  \( 0.15 + 0.85 u^{1.7} \). Flood gain 0.35 to 0.95.

A frequency whose spacing cannot fit the playback duration is refused.

## Life cycle and field

Each storm grows (first quarter of its life), holds (to 70%), and decays, while
its centre drifts up to 30% of its radius along a per-storm wind direction.
Rain at a node combines storms as independent probabilities through a
Wendland C² kernel. The formulas are in [Mathematical model:
weather](../concepts/mathematical-model.md#weather).

## Manual storms

`POST /api/v1/control/events/weather` adds a storm at a node: intensity
[0, 1], radius > 0, duration 1 to 1440 virtual minutes, flood gain [0, 1].
It starts now, or 5 playback seconds after the previous manual storm. Undo
sets its intensity to 0.

## Observing storms

- `GET /api/v1/view/weather`: every scheduled and manual storm with its
  window and whether it is active.
- Snapshot `active_weather`: current centre (lat/lon and metres), radius,
  intensity and phase of each active storm.
- News: `DWS_RAIN_SCHEDULED`, `DWS_RAIN_STARTED`, `DWS_RAIN_PEAK`,
  `DWS_RAIN_ENDED`.

Disabling the `dws` module removes all rain; flooding then drains away.
