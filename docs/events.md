# Event Stack & Telemetry Engine

DSTNS features a high-performance, deterministic Event Stack responsible for sequencing, activating, and logging spatiotemporal network occurrences.

---

## 1. Event Ordering & Deterministic Tie-Breaking

To guarantee identical execution order across compilers, CPU architectures, and execution runs, events sharing the same virtual second use a strict 3-tuple tie-breaking predicate:

$$\text{Order}(E_a, E_b) \iff (t_{\text{virtual}}, -\text{priority}, \text{event\_id})$$

1. **Virtual Timestamp ($t_{\text{virtual}}$)**: Earlier events always execute before later events.
2. **Priority**: Higher-priority events (e.g. critical bridge closures, emergency vehicle dispatches) preempt lower-priority background updates.
3. **Deterministic Event ID**: A monotonic sequence number generated deterministically during scenario compilation breaks ties for events with identical time and priority.

---

## 2. Event Categories & Lifecycle

Events progress through four discrete lifecycle states:
- **`Scheduled`**: Stored in the scenario event priority queue waiting for $t_{\text{sim}} \ge t_{\text{event}}$.
- **`Active`**: Currently influencing simulation dynamics (e.g., active rain storm, active traffic surge, active road closure).
- **`Resolved`**: Duration expired; effects cleanly restored or deactivated.
- **`Cancelled`**: Operator-cancelled or preempted prior to execution.

### Telemetry News Categories
- `SCENARIO_INIT`: Road network, stop, and signal counts.
- `DWS_STORM_CELL`: Atmospheric disturbance detected.
- `INCIDENT_ACTIVATED`: Disruption triggered on specific edge and nodes.
- `INCIDENT_RESOLVED`: Edge capacity/speed restored.
- `TRANSIT_DISPATCH`: Public transit bus scheduled or departs stop.
- `FLOOD_WARNING`: Surface water accumulation exceeds safety limits.

---

## 3. UI Synchronization & News Feed API

The event stream is exposed to clients through:
1. **News Feed API (`GET /api/v1/news`)**: Returns paginated event ledger items with timestamps, categories, and human-readable headlines.
2. **Live State Snapshot (`GET /api/v1/view/snapshot`)**: Contains the latest news ticker items for real-time operator alerts without polling full history.
