# News API

News is the operator-facing narrative of a run: a worded stream of what
matters, with structured data alongside. The observer's notifications and
News list are built from it.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/news?since_news_id=N&limit=L` | Items with `news_id > N`, oldest first, at most `L` (1 to 500, default 100) |
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
