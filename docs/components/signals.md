# Traffic Signal Planning (`dstns::ScenarioCompiler`, `dstns::SimulationEngine`)

## Purpose
Selects candidate signalized intersections across high-degree road nodes and assigns deterministic two-direction phase timing.

## Signal Selection & Timing
1. **Candidate Intersections**: Nodes with degree $\ge 4$ and canonical IDs divisible by 3 are signalized.
2. **Cycle Length Calculation**: IDs divisible by 5 use longer bottleneck cycles in $[90,120]$ seconds. Other reachable signal IDs produce cycles in $[33,72]$ seconds.
3. **Phase Allocations**: Each direction receives a deterministic green, 3-second yellow, and 1-second all-red clearance. The explicit phase sum never exceeds the cycle; an odd non-bottleneck cycle leaves one additional implicit all-red second.
4. **Intermediate Transitions**: Transitions guarantee safe yellow clearances rather than instant phase jumping.

## Data Structure
```cpp
struct SignalPlan {
    NodeId node;
    std::uint16_t cycle_s{};
    std::vector<std::uint16_t> phases_s;
};
```
