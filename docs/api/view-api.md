# View API

Reading the world and its state. Every route returns the standard envelope:

```json
{
  "ok": true, "api_version": "1.0",
  "run_id": "run_4f1fccc516c6", "seed": "382923", "global_seed": "0x…05d7cb",
  "state_revision": 29162, "config_revision": 3,
  "clock": { "playback_state": "RUNNING", "virtual_day_seconds": 29160,
             "simulated_current_time": "08:06:00", "simulation_percentage": 0.3375,
             "playback_duration_seconds": 3600, "base_rate": 24, "tick_rate": 1, "target_virtual_rate": 24 },
  "data": { }
}
```

`simulation_percentage` is a **fraction** in [0, 1]. Without a world, `data`
is empty.

## Routes

| Route | `data` | Size | Fetch |
|---|---|---|---|
| `/view/topology` | Static graph, places, projection, location, bounds | Large | Once per `run_id` |
| `/view/snapshot` | Dynamic state of every node and edge, signals, demand, congestion, active events, last 25 news | Medium | Each frame |
| `/view/global` | Topology and snapshot together, plus manifest | Largest | Rarely |
| `/view/nodes`, `/view/edges` | Paged static + dynamic records | Small pages | On demand |
| `/view/nodes/{id}`, `/view/edges/{id}` | One record | Tiny | On inspection |
| `/view/places`, `/view/place-kinds`, `/view/stops` | Classified places with live demand | Medium | Occasionally |
| `/view/event-queue` | Scheduled or executed events, paged | Small | On demand |
| `/view/traffic`, `/view/metrics` | Network totals | Tiny | Each frame, if needed |
| `/view/congestion` | Network congestion index and its history | Small | Each frame |
| `/view/signals` | Controller states | Medium | Each frame, if needed |
| `/view/weather`, `/view/events` | Scheduled and manual storms | Small | Occasionally |
| `/view/incidents` | Every incident of the day | Small | Occasionally |
| `/view/buildings`, `/view/bus-stops` | Node-level buildings; routable stops | Small | Once |
| `/view/manifest` | Hashes and versions for reproducibility, calendar and terrain provenance | Tiny | Once |
| `/view/environment` | The coupled environment: calendar, terrain provenance, road grade summary, available fields | Small | Once per `run_id`, then occasionally |
| `/view/road-environment` | Every directed road's grade, water, flood index, surface temperature, multipliers, closure, passability by vehicle class and energy, paged (`limit` up to 5,000) | Medium | On inspection |
| `/view/fields/{name}` | One environmental field as a raster; `?max_side=` (8 to 512, default 160) | Medium | Once for a static field; every few seconds for a changing one, only while shown |
| `/view/run`, `/view/config` | Same as `/playback/status` | Tiny | — |

Aliases: `/api/v1/topology`, `/view/network` and `/view/map/full` serve the
topology; `/view/world`, `/view/all` and `/view/global.json` serve the global
view; `/api/v1/places` serves places.

## Topology

```json
{
  "nodes": [ { "id": 0, "osm_node_id": 1070809009, "position": { "lat": -6.79, "lon": 39.20, "x_m": -812.4, "y_m": 233.1 },
               "degree": 4, "bus_stop": false, "signal": true,
               "signal_cycle_s": 76, "signal_offset_s": 12, "signal_green_s": 35,
               "building": null, "building_impact": 0, "building_radius_m": 0 } ],
  "edges": [ { "id": 0, "from": 0, "to": 1, "reverse_twin": 1, "road_class": "primary",
               "name": "Morogoro Road", "tags": { "highway": "primary", "lanes": "2" },
               "synthetic_reverse": false, "length_m": 84.2, "free_speed_mps": 16.67, "lanes": 2,
               "geometry": [ { "lat": …, "lon": …, "x_m": …, "y_m": … } ] } ],
  "features": [ { "id": "way/123", "name": "…", "category": "school", "polygon": true,
                  "position": { … }, "geometry": [ … ], "tags": { … },
                  "anchor_node": 412, "demand_type": "school" } ],
  "source": "OpenStreetMap", "map_selection_version": "urban-crfg-v3",
  "projection": { "name": "local equirectangular", "origin_lat": …, "origin_lon": …, "units": "metres" },
  "location": { "city": "Dar es Salaam", "country": "Tanzania", "anchor_lat": -6.7952, "anchor_lon": 39.2028,
                "city_extent_m": 5000, "downloaded": true },
  "root_node": 1543, "graph_hash": "sha256:…",
  "bounds": { "min_lat": …, "max_lat": …, "min_lon": …, "max_lon": … }
}
```

`x_m` and `y_m` are true metres from the projection origin. `location.city`
is empty for a pinned map. Each node also carries `elevation_m` and each edge its
`grade` (rise over run in its own direction; the reverse twin has the negation),
both 0 on flat terrain. See [Terrain](../concepts/terrain.md).

## Environment fields

```json
{ "name": "elevation", "units": "m", "width": 108, "height": 108,
  "origin_x_m": -1530.0, "origin_y_m": -1290.0, "cell_m": 25.0, "solver_cell_m": 25.0,
  "min": 27.5, "max": 55.2,
  "layout": "row-major, south row first; cell (0,0) is the south-west corner",
  "values": [ 31.2, 31.4, … ] }
```

Fields are reduced for display by block means, so the solver's own resolution
(`solver_cell_m`) never has to be sent. Available now: `elevation` (m, to 0.1 m),
`slope` (m/m), `irradiance` (W/m²), `surface_temperature` (°C), `cloud`
(fraction) and `water_depth` (m, to the millimetre). `/view/environment` lists what the current world offers, with each
field's units and whether it is static or changes during the run. An unknown
field returns 400.

## Snapshot

`data` keys: `nodes`, `edges`, `signals`, `demand`, `congestion`,
`active_weather`, `active_weather_events`, `active_surges`,
`active_incidents`, `event_stack`, `topology_revision`.

An edge:

```json
{ "id": 5, "congestion": 0.42, "rainfall": 0.1, "flood": 0.0,
  "effective_speed_mps": 9.8, "mean_speed_mps": 7.1,
  "vehicle_count": 14, "halting_count": 3,
  "demand_vph": 1650.0, "effective_capacity_vph": 1710.0,
  "closed": false, "incident_closed": false, "manual_closed": false,
  "incident_speed_multiplier": 1.0, "signal_multiplier": 1.0,
  "demand_causes": ["school morning arrivals"] }
```

A signal:

```json
{ "signal_id": 5, "junction_id": 5, "enabled": true, "cycle_length": 76,
  "phases_s": [35, 3, 1, 33, 3, 1], "phase": 3, "phase_name": "B green",
  "group_a": "red", "group_b": "green",
  "phase_started_at": -14, "time_in_phase": 14, "next_transition_at": 19,
  "manual_override": false }
```

Under a manual override, `manual_override` is true and the timing fields are
`null`.

## Paged records

```bash
curl -s 'localhost:8090/api/v1/view/edges?offset=0&limit=250'
curl -s localhost:8090/api/v1/view/edges/412
```

`limit` is 1 to 1000 (default 250), `offset` any non-negative integer. An ID
beyond the graph is 404 `NOT_FOUND`; one that does not fit 32 bits is 400. Edge
records group their fields into `source`, `road`, `traffic`, `weather` and
`control`; node records into `roles`, `building` and `weather`.

## Network totals

```json
GET /api/v1/view/traffic
{ "network_congestion_length_weighted": 0.18, "network_congestion_p95": 0.61,
  "mean_vehicle_speed_mps": 9.62, "vehicle_count": 1873, "halting_vehicle_count": 211,
  "flooded_edge_count": 4, "closed_edge_count": 1,
  "active_dws_events": 1, "hotspot_edge_count": 24 }
```

Totals cover traversable directions only; synthetic reverse edges of one-way
roads are excluded.

```json
GET /api/v1/view/congestion
{ "current": 18.2, "average": 12.7, "delta": 0.4, "ema_tau_virtual_s": 900,
  "weighting": "edge length × lanes; traversable directions only",
  "source": "DSTNS aggregate traffic model",
  "history": [ { … one sample per virtual minute … } ] }
```

The network index is 0 to 100; per-edge `congestion` is 0 to 1.

## Places

See [API reference: places](reference.md#places) for `/view/places`,
`/view/place-kinds` and `/view/stops`.

## Event queue

See [Events: reading events](../concepts/events.md#reading-events).
