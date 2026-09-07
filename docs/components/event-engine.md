# Events and Manual Overlays (`dstns::SimulationEngine`)

## Purpose
`SimulationEngine` consumes deterministic scenario data, coordinates runtime weather and traffic controls, emits news, and maintains an undo/redo journal for supported controls.

## Responsibilities
- Consume deterministic DWS events and planned trips compiled into `Scenario`; traffic and signal behavior are calculated from virtual time rather than represented as a generic event stack.
- Apply runtime manual controls such as weather injections, edge overrides, module/day changes, and tick-rate changes.
- Maintain a linear history journal for the command types handled by `apply_command`: tick rate, day, module toggles, edge overrides, and manual weather. Other controls must not be assumed undoable merely because they emit news.
- Generate structured News notifications for all scheduled and manual event triggers.

## Mathematical State Composition
Effective dynamic state $X(t)$ is composed via layering:
$$X(t) = X_{\text{base}}(t) \oplus X_{\text{manual\_overlays}}(t) \oplus X_{\text{overrides}}(t)$$
For supported command types, undo applies the recorded `before` value and redo applies `after` without regenerating the base scenario.

## Public Interfaces
```cpp
class SimulationEngine {
public:
    nlohmann::json add_weather(NodeId epicenter, double intensity, double radius_m, std::uint32_t duration_min, double flood_gain);
    nlohmann::json override_edge(EdgeId edge, double speed_multiplier, double capacity_multiplier, bool closed);
    nlohmann::json undo(std::uint32_t count);
    nlohmann::json redo(std::uint32_t count);
};
```
