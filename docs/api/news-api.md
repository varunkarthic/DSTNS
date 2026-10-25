# News API

News is the operator-facing narrative of a run: a worded stream of what
matters, with structured data alongside. The observer's notifications and
News list are built from it.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/news?since_news_id=N&limit=L` | Items with `news_id > N`, oldest first, at most `L` (1 to 500, default 100). Add `narration=realistic&since_narration=S` for [Realistic News](#realistic-news) |
| GET | `/api/v1/news/stream` | The latest 100 items as one server-sent event (see [Streaming](streaming.md)) |

The last 25 items also arrive in every snapshot as `event_stack`.

## An item

```json
{
  "news_id": 2,
  "event_id": 1,
  "virtual_day_s": 0,
  "simulated_current_time": "00:00:00",
  "category": "system",
  "severity": "info",
  "template_id": "NETWORK_TOPOLOGY_LOADED",
  "message": "[00:00:00] Road network loaded: 2554 directional edges, 1196 intersections.",
  "data": { "edges": 2554, "nodes": 1196 }
}
```

| Field | Meaning |
|---|---|
| `news_id` | Increasing within a run; use it as the cursor |
| `event_id` | The event the item describes (a storm, an incident, a command) |
| `virtual_day_s`, `simulated_current_time` | When, in virtual time |
| `category` | `system`, `traffic`, `weather`, `flooding`, `incident`, `signals`, `demand`, `control` |
| `severity` | `info`, `warning` or `alert` |
| `template_id` | A stable identifier for the kind of item (below); match on this, not on `message` |
| `message` | Human-readable text; may change between versions |
| `data` | Structured details, which vary by template |
| `narrative` | Only with `narration=realistic`: the item as [Realistic News](#realistic-news), when the narrator has written it |

## Templates

| `template_id` | Category | Severity | When |
|---|---|---|---|
| `SCENARIO_INITIALIZED` | system | info | The run is installed; `data.scenario_hash` |
| `NETWORK_TOPOLOGY_LOADED` | system | info | With the node and edge counts |
| `WEATHER_FORECAST` | weather | info | Start of day: how many storms are scheduled |
| `DWS_RAIN_SCHEDULED` | weather | info | One per scheduled or manual storm: epicentre, radius, start |
| `DWS_RAIN_STARTED` | weather | warning | A storm begins: epicentre, radius, intensity |
| `DWS_RAIN_PEAK` | weather | alert | Halfway through a storm |
| `DWS_RAIN_ENDED` | weather | info | A storm clears |
| `FLOOD_STARTED` | flooding | warning | An edge becomes flood-affected |
| `SIGNALS_ONLINE` | signals | info | Start of day: controller count |
| `SIGNAL_MANUAL_OVERRIDE` | signals | info | An operator toggles a junction |
| `PHYSICS_ENGINE_ACTIVE` | traffic | info | Start of day |
| `TRAFFIC_SURGE_ACTIVE` | traffic | warning | An operator triggers a demand surge |
| `INCIDENT_ACTIVATED` | incident | info, warning or alert | An incident begins, by type: congestion is low, closures and spills high |
| `INCIDENT_RESOLVED` | incident | info | An incident clears |
| `DEMAND_CHANGED` | demand | info or warning | A place's demand changes (buildings module) |
| `DAY_CHANGED` | control | info | Weekday/weekend switched |
| `MODULE_ENABLED`, `MODULE_DISABLED` | control | info | A module switched |

## Following the feed

```bash
since=0
while true; do
  page=$(curl -s "localhost:8090/api/v1/news?since_news_id=$since&limit=500")
  echo "$page" | python3 -c 'import json,sys; [print(n["message"]) for n in json.load(sys.stdin)["data"]["items"]]'
  since=$(echo "$page" | python3 -c 'import json,sys; i=json.load(sys.stdin)["data"]["items"]; print(max([n["news_id"] for n in i], default='"$since"'))')
  sleep 1
done
```

!!! warning "Reset your cursor when time moves backwards"
    Seeking backwards restores a checkpoint, which truncates the news to that
    point and **reuses** the IDs after it. When `clock.virtual_day_seconds`
    decreases, or `run_id` changes, start again from `since_news_id=0`. The
    observer does exactly this.

Disabling the `news` module stops new items being posted; existing ones remain.

## Realistic News

[Realistic News](../guide/narration.md) is the observer's: by default the feed is
exactly the core's, whatever narrator the server runs. A client that wants it
asks by name with `narration=realistic`, and items the narrator has written then
carry a `narrative` beside their `message`:

```json
{
  "news_id": 41,
  "template_id": "INCIDENT_ACTIVATED",
  "message": "[06:37:06] Emergency road closure: through-traffic prohibited on corridor on Edge #1168 near Node #430. (HIGH SEVERITY)",
  "narrative": "Through-traffic prohibited on Rua Bartholemew Dias Street in the north-west district. The road is closed.",
  "data": { "incident_id": 2, "type": "road_closure", "edge_id": 1168, "closed": true }
}
```

`message`, `data` and `template_id` are exactly what they would be without a
narrator; match on them, and treat `narrative` as display text that may be
absent.

A narration can finish after its item was delivered. To catch those without
re-reading the feed, pass back the `narration_sequence` of the previous page as
`since_narration` (with `narration=realistic`). The page then lists, under `narrated`, items you already
hold (`news_id <= since_news_id`, among the latest 200) whose narration
finished since:

```json
{
  "items": [],
  "narrated": [{ "news_id": 41, "narrative": "Through-traffic prohibited on ..." }],
  "narration_sequence": 17
}
```

Both fields appear only with `narration=realistic` and a narrator attached;
otherwise the page keeps its original shape. Snapshots' `event_stack` never
carries narratives. Reset the cursor to 0 whenever you reset `since_news_id`.
