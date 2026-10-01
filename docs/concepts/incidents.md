# Incident Subsystem Architecture & Physics Coupling

The Incident Subsystem in DSTNS introduces first-class, deterministic, spatiotemporally distributed disruption events to the urban road network. Incidents model real-world disruptions such as road closures, traffic accidents, heavy congestion, vehicle breakdowns, construction restrictions, and infrastructure failures.

---

## 1. Core Objectives & Invariants

1. **Deterministic Scheduling**: Incidents are generated strictly via the domain-separated `incident_rng` (`Seed128::derive("incidents")`). Identical seeds produce bit-for-bit identical incident schedules.
2. **Minimum Incident Guarantee**: A standard scenario guarantees at least $\ge 4$ incidents (configurable via `ScenarioConfig::minimum_incidents`, defaulting to 4).
3. **Temporal Distribution**: Incidents are scheduled deterministically across the virtual day, partitioned into early ($[3600, 21600)$), midday ($[21600, 50400)$), and late ($[50400, 75600)$) slots.
4. **Valid Topological Targeting**: Incidents only target traversable edges (length $> 10\text{m}$, valid endpoints $u \neq v$, non-zero speed limits).
5. **Physical Simulation Effects**:
   - **Road Closure**: Forces `incident_closed = true`, preventing routing and traffic flow.
   - **Congestion / Accident**: Attenuates `incident_speed_multiplier` (e.g. $0.20 \times - 0.40 \times$).
   - **Restriction**: Attenuates `incident_capacity_multiplier` (e.g. $0.50 \times$).
6. **Robust Overlapping Resolution**: Multiple concurrent incidents on the same edge combine cleanly without clobbering base state. When one incident resolves, active effects from remaining incidents persist.

---

## 2. Incident Data Model

Defined in `include/dstns/model.hpp`:

```cpp
enum class IncidentType : std::uint8_t {
    RoadClosure = 0,
    Accident,
    Congestion,
    VehicleBreakdown,
    TemporaryRestriction,
    InfrastructureFailure,
};

enum class IncidentLifecycle : std::uint8_t {
    Scheduled = 0,
    Active,
    Resolved,
    Cancelled,
};

struct Incident {
    std::uint64_t id{0};
    IncidentType type{IncidentType::RoadClosure};
    IncidentLifecycle lifecycle{IncidentLifecycle::Scheduled};
    EdgeId target_edge{0};
    NodeId from_node{0};
    NodeId to_node{0};
    std::uint32_t start_time_s{0};
    std::uint32_t end_time_s{0};
    double speed_multiplier{1.0};
    double capacity_multiplier{1.0};
    bool closes_road{false};
    std::string description{};
};
```

---

## 3. Dynamic Edge State Augmentation

In `EdgeDynamic`:
- `double incident_speed_multiplier{1.0};`
- `double incident_capacity_multiplier{1.0};`
- `bool incident_closed{false};`

During each simulation tick `SimulationEngine::physics_step()`:
1. Every edge's incident fields are reset to default neutral values (`speed_mult = 1.0`, `cap_mult = 1.0`, `closed = false`).
2. The engine evaluates all active incidents (`start_time_s <= virtual_time_s < end_time_s`).
3. For overlapping incidents on the same edge, multipliers compose conservatively:
   $$\text{speed\_mult} = \min(\text{speed\_mult}, \text{inc.speed\_multiplier})$$
   $$\text{cap\_mult} = \min(\text{cap\_mult}, \text{inc.capacity\_multiplier})$$
   $$\text{closed} = \text{closed} \lor \text{inc.closes\_road}$$
4. The effective edge speed is modulated:
   $$v_{\text{eff}} = v_{\text{base}} \times f_{\text{weather}} \times f_{\text{flood}} \times f_{\text{incident\_speed}} \times (1 - C)^{\alpha}$$
   If `incident_closed` or `is_closed` is true, $v_{\text{eff}} = 0$.

---

## 4. Lifecycle Transitions & Event Logging

When an incident transitions state:
- **`Scheduled -> Active`**: Triggered when $t_{\text{sim}} \ge t_{\text{start}}$. The engine emits a telemetry news item:
  ```json
  {
    "category": "INCIDENT_ACTIVATED",
    "headline": "INCIDENT_ACTIVATED: RoadClosure on edge 42 (Node 10 -> Node 15)",
    "priority": 2
  }
  ```
- **`Active -> Resolved`**: Triggered when $t_{\text{sim}} \ge t_{\text{end}}$. The engine emits:
  ```json
  {
    "category": "INCIDENT_RESOLVED",
    "headline": "INCIDENT_RESOLVED: RoadClosure on edge 42 restored",
    "priority": 1
  }
  ```

---

## 5. API Endpoints

### 1. Dedicated Incidents View: `GET /api/v1/view/incidents`
Returns the complete scenario catalog of incidents with current lifecycles:
```json
{
  "ok": true,
  "data": {
    "total_incidents": 4,
    "active_count": 1,
    "incidents": [
      {
        "id": 1,
        "type": "RoadClosure",
        "lifecycle": "Active",
        "target_edge": 42,
        "from_node": 10,
        "to_node": 15,
        "start_time_s": 7200,
        "end_time_s": 10800,
        "speed_multiplier": 0.0,
        "capacity_multiplier": 0.0,
        "closes_road": true,
        "description": "Emergency road closure due to structural hazard"
      }
    ]
  }
}
```

### 2. State Snapshot Integration: `GET /api/v1/view/snapshot`
The real-time snapshot contains the `active_incidents` array containing all currently active incidents with edge and node context.

---

## 6. Testing & Invariant Verification

- **Unit Tests (`tests/unit/test_main.cpp`)**:
  - `IncidentSubsystem_MinimumCount`: Confirms $\ge 4$ incidents are generated across diverse seeds.
  - `IncidentSubsystem_TemporalDistribution`: Verifies incidents populate early, midday, and late day buckets.
  - `IncidentSubsystem_EdgeResolution`: Verifies edge multipliers correctly attenuate and restore upon resolution.
- **Property Invariants (`tests/property/property_tests.cpp`)**:
  - Valid edge IDs ($< |E|$), valid nodes ($< |V|$), $t_{\text{start}} < t_{\text{end}}$, multipliers in $[0, 1]$.
- **API Smoke Tests (`tests/api/api_smoke.py`)**:
  - Validates schema and fields for `/api/v1/view/incidents` and `snapshot.data.active_incidents`.
