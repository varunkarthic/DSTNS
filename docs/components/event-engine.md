# Event Engine & Manual Overlays (`dstns::engine`)

## Purpose
The Event Engine manages the deterministic precompiled schedule of simulation events, coordinates runtime manual overlay events (weather injections, capacity/speed modifiers, road closures), and maintains an undo/redo journal without altering base deterministic schedules.

## Responsibilities
- Precompile deterministic base event stacks (DWS storms, traffic peak shifts, signal updates).
- Ingest runtime manual control events and attach them as dynamic overlays.
- Maintain a linear history journal of operations for state reversal (`undo`) and forward reapplication (`redo`).
- Generate structured News notifications for all scheduled and manual event triggers.

## Mathematical State Composition
Effective dynamic state $X(t)$ is composed via layering:
$$X(t) = X_{\text{base}}(t) \oplus X_{\text{manual\_overlays}}(t) \oplus X_{\text{overrides}}(t)$$
Undoing a manual control operation removes its overlay without recalculating or regenerating the base scenario.

## Public Interfaces
```cpp
class SimulationEngine {
public:
    nlohmann::json apply_weather_event(NodeId epicenter, double intensity, double radius_m, double duration_mins, double flood_gain);
    nlohmann::json apply_edge_override(EdgeId edge, std::optional<double> speed_mult, std::optional<double> cap_mult, std::optional<bool> closed);
    nlohmann::json undo(std::size_t count);
    nlohmann::json redo(std::size_t count);
};
```
