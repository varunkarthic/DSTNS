# Deterministic events

Everything that happens in a DSTNS day at a particular moment is an event:
signal phase changes, demand changes at places, storms, incidents and
flooding. This page describes where events come from, how the engine
executes them in a deterministic order, and how clients read them.

## Contents

- [Sources of events](#sources-of-events)
- [The event runtime](#the-event-runtime)
- [Ordering and determinism](#ordering-and-determinism)
- [Reading events](#reading-events)
- [News](#news)
- [Events and time travel](#events-and-time-travel)

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
every snapshot's `event_stack`. See [News API](api/news-api.md).

## Events and time travel

Checkpoints include the event runtime, so seeking backwards restores the
schedule, the history and the demand state exactly as they were, and replaying
forward re-executes the same events in the same order. News is truncated to
the checkpoint and its IDs restart from there; clients should reset their
`since_news_id` cursor when the clock moves backwards, as the observer does.
Operator actions are not replayed: they are the operator's, and stand until
undone. See [Simulation engine](simulation-engine.md#checkpoints-and-seeking).
