# Traffic Signal Subsystem (`dstns::scenario`)

## Purpose
Selects candidate signalized intersections across high-degree road nodes and calculates Webster-style signal phase timings.

## Signal Selection & Timing
1. **Candidate Intersections**: Road nodes with degree $\ge 3$ are evaluated using `RngDomain::Signals`.
2. **Cycle Length Calculation**: Webster optimum cycle formula calculates baseline cycle lengths $C \in [60, 120]\text{ seconds}$.
3. **Phase Allocations**: Cycle times are partitioned into green, yellow (3s), and all-red clearance intervals proportional to incoming road capacities.
4. **Intermediate Transitions**: Transitions guarantee safe yellow clearances rather than instant phase jumping.

## Data Structure
```cpp
struct SignalPlan {
    NodeId node;
    std::uint16_t cycle_s{};
    std::vector<std::uint16_t> phases_s;
};
```
