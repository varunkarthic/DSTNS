# Deterministic events

Everything that happens in a DSTNS day at a particular moment is an event:
signal phase changes, demand changes at places, storms, incidents and
flooding. This page describes where events come from, how the engine
executes them in a deterministic order, and how clients read them.


## Sources of events

| Source | Scheduled by | Category | Known in advance |
|---|---|---|---|
| Signal phase changes | Each controller's cycle, green split and offset | `signals` | Yes |
| Place demand changes | The diurnal demand schedule, every `demand_bin_virtual_s` (300 s) | `demand` | Yes |
| Storms | `ScenarioCompiler::plan_weather`, `dws.frequency` per day | `weather` | Yes |
| Incidents | The compiler, at least four per day, spread over early, midday and late slots | `incidents` | Yes |
| Flood threshold crossings | Physics, when an edge's flood level crosses 0.01 | `flooding` | No: history only |

Operator actions (overrides, toggles, manual rain, surges, rate, day and
module changes) are not queue events. They are recorded in the control history
(`GET /api/v1/control/history`, which also drives undo and redo), in the SQLite
`event_log` table, and in news; surges appear in news only and cannot be
undone. The `system` category filter is accepted but
currently matches nothing.

Scheduled events come from the seed. The same seed and configuration always
produce the same schedule, and `event_hash` fingerprints it.

## The event runtime

`EventRuntime` (`src/events.cpp`) owns the schedule during a run:

- **A min-heap of pending events** ordered by `(time, sequence)`. Signals keep
  exactly one pending transition each, so a network of 10,000 controllers
  costs O(log n) per transition rather than a scan per second.
- **A bounded history** of the last 2,000 executed events, plus a total
  `executed_count`.
- **The demand state**: each place's scheduled baseline, its effective demand
  after couplings, and the named factors explaining the difference.

Each physics step calls `advance(scenario, t)`, which pops and executes every
event due at or before `t`, and then `recouple`, which recomputes place demand
from the network's present condition (closed roads, rain, nearby incidents) so
the figures the operator sees always describe the current tick.

## Ordering and determinism

Ties at the same virtual second are broken by a monotonically increasing
sequence number assigned when the event was pushed. Because pushes happen in a
fixed order (initialisation order, then execution order), two runs of the same
scenario execute identical sequences. The replay suite checks this through full
snapshot equality.

## Mathematics

### Ordering

Events are ordered by a strict total order on `(time, sequence)`:

\[
e_1 \prec e_2 \;\iff\; (t_1, q_1) <_{\text{lex}} (t_2, q_2)
\]

where \( t \) is the virtual second and \( q \) the sequence number assigned when the
event was pushed. Because \( q \) is unique and increases monotonically, no two events
compare equal, so the execution order is fully determined even when many events share
a second. In code the heap is a min-heap on exactly this pair:

```cpp
struct ScheduledEvent {
    std::uint32_t time, entity, phase;  std::uint64_t sequence;
    std::string category, description;  double value;
    bool operator>(const ScheduledEvent& b) const { return std::tie(time, sequence) > std::tie(b.time, b.sequence); }
};
std::priority_queue<ScheduledEvent, std::vector<ScheduledEvent>, std::greater<ScheduledEvent>> queue_;
```

`std::tie` builds a tuple of references, and tuple comparison is lexicographic, so
`(time, sequence)` is compared in that order. A heap push or pop costs
\( O(\log n) \), and reading the next event, \( O(1) \).

### Why one pending event per signal

A controller cycles forever, so scheduling its whole day up front would put
\( 6 \cdot 86400 / T \) events in the queue for a cycle length \( T \): for
\( T = 76 \) s, **6,821** events per controller per day, and 68 million for 10,000
controllers. Instead each controller keeps exactly **one** pending transition; when it
fires, executing it pushes the next:

```cpp
// advance(): execute everything due at or before `time`
auto e = queue_.top();  queue_.pop();
state.phase = e.phase;  state.phase_started = e.time;
state.next_transition = e.time + plan.phases_s[e.phase];
if (state.next_transition <= 86400)
    push({state.next_transition, e.entity, (e.phase + 1) % 6, 0, "signals", ...});   // schedule the next one
```

The queue therefore holds \( n \) signal events plus the place-demand events, memory is
\( O(n) \), and the work per virtual second is the number of transitions that happen in
it, about \( 6/T \) per controller:

\[
\text{events per virtual second} \;\approx\; \sum_{c} \frac{6}{T_c} \;\;\xrightarrow{\;n = 10^4,\; T = 76\;}\;\; \approx 790
\]

each costing \( O(\log n) \).

### Initial phase from the offset

A controller does not start every day at the beginning of its cycle; its offset
\( o \) (the green-wave progression) places it part-way through. Walking the phase
lengths \( \ell_0, \dots, \ell_5 \) subtracts each from the remainder until the
remainder fits inside a phase:

```cpp
auto remainder = std::uint32_t(p.offset_s);  std::uint32_t phase = 0;
while (remainder >= p.phases_s[phase]) { remainder -= p.phases_s[phase]; ++phase; }
signals.push_back({phase, p.phases_s[phase] - remainder, -static_cast<std::int64_t>(remainder)});
```

For the plan \( (35, 3, 1, 33, 3, 1) \) (a 76 s cycle) and \( o = 50 \): subtracting
35, 3 and 1 leaves 11, which is inside the 33 s phase 3 ("B green"). So the controller
starts in phase 3, \( 33 - 11 = 22 \) s from its next transition, having begun
11 s *before* time zero (`phase_started = -11`).

### Effect on traffic

An approach's `signal_multiplier` depends on its group and the phase: group A is
approaches that are mostly north-south (\( |\Delta y| \ge |\Delta x| \)), group B the rest.

| Phase | Group A | Group B |
|---|---|---|
| 0 A green | 1.00 | 0.08 |
| 1 A amber | 0.40 | 0.08 |
| 3 B green | 0.08 | 1.00 |
| 4 B amber | 0.08 | 0.40 |
| 2, 5 all red | 0.08 | 0.08 |

Averaging over a cycle gives each group's effective throughput relative to an
unsignalled road, with \( g \) its green time, \( a = 3 \) s of amber and
\( T \) the cycle:

\[
\bar m \;=\; \frac{g \cdot 1 \;+\; a \cdot 0.4 \;+\; (T - g - a) \cdot 0.08}{T}
\]

For the 76 s plan, \( \bar m_A = (35 + 1.2 + 3.04)/76 = 0.516 \) and
\( \bar m_B = (33 + 1.2 + 3.2)/76 = 0.492 \): roughly half of free-flow capacity,
split nearly evenly because the greens (35 and 33 s) are close, as they should be when
the two directions carry similar demand.

## Reading events

`GET /api/v1/view/event-queue` pages through either view:

| Parameter | Values | Default |
|---|---|---|
| `view` | `future` (pending) or `history` (executed) | `future` |
| `category` | `all`, `signals`, `demand`, `incidents`, `weather`, `flooding`, `system` | `all` |
| `offset` | 0 to 100000 | 0 |
| `limit` | 1 to 200 | 50 |

```json
{
  "items": [
    { "id": 48211, "virtual_s": 29160, "entity": 412, "category": "signals",
      "description": "Signal phase change", "status": "scheduled", "phase": 3, "value": 0 }
  ],
  "total": 1873, "offset": 0, "limit": 50,
  "pending_count": 1873, "executed_count": 52004, "history_retention": 2000
}
```

`total` counts what matched the category filter. Future flooding is never
listed, because it is not predicted: it appears in history when it happens.

## News

News is the operator-facing narrative of the same day: a smaller, worded stream
of what matters. Each item has an ID, the event it describes, the virtual time,
category, severity (`info`, `warning`, `alert`), a template ID the observer
uses for grouping and notifications, a message and structured data. Read it
with `GET /api/v1/news?since_news_id=N&limit=1..500`, or the last 25 items in
every snapshot's `event_stack`. See [News API](../api/news-api.md).

## Events and time travel

Checkpoints include the event runtime, so seeking backwards restores the
schedule, the history and the demand state exactly as they were, and replaying
forward re-executes the same events in the same order. News is truncated to
the checkpoint and its IDs restart from there; clients should reset their
`since_news_id` cursor when the clock moves backwards, as the observer does.
Operator actions are not replayed: they are the operator's, and stand until
undone. See [Simulation engine](simulation-engine.md#checkpoints-and-seeking).
