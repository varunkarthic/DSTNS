# Your first simulation

A guided tour: start a run, read the map, move through the day, change things,
and save a report. It takes about fifteen minutes. You need DSTNS running
([Quick start](quick-start.md)).

!!! tip "The built-in tutorial"
    The observer has its own interactive tutorial: click **Tutorial** in the top
    bar. This page covers the same ground with the reasoning behind it.

## 1. Start a known run

Use a fixed seed so what you see matches this page:

=== "From source"

    ```bash
    ./launcher start --seed 382923
    ```

=== "Docker"

    ```bash
    docker compose exec dstns dstns-run --seed 382923
    ```

The seed is the whole identity of the run. It chooses the city and district,
the signal timings, the weather, the incidents, everything. Run the same seed
again tomorrow on another machine and you get the same day. See [Seeds and
places](../guide/seeds-and-places.md).

While the world is prepared, the start-up screen reports what the core is
doing: **Selecting world**, **Downloading map** (the first time for a city),
**Generating world**, **Initializing simulation**.

## 2. Read the screen

![The observer](../assets/screenshots/observer.png){ .screenshot }

| Area | What it shows |
|---|---|
| **Map** | Every road of the district, coloured by congestion: clear, moderate, severe, flooded, closed. Markers are places: schools, offices, shops, stops. Pan with drag, zoom with the wheel |
| **Telemetry** (right) | Road and vehicle counts, incidents, weather, the congestion index, and lists: Stack (subsystems), News, Queue (what is scheduled next), Incidents, Notifications |
| **Sidebar** (left) | Zoom, fit, place search, Auto Focus, Do Not Disturb, reduced motion, Settings |
| **Lower HUD** | Notifications, the Layers menu and legends, the cursor's coordinates and a scale bar |
| **Command rail** (bottom) | Playback, the clock, speed, the seed, the runtime status, Terminate |

Hover anything for a tooltip. Click a road or a place on the map to inspect it.

## 3. Move through the day

The clock starts at 00:00:00 and a full day takes an hour of wall-clock time
at 1×.

| Do | Control | What happens |
|---|---|---|
| Pause and play | **Play / Pause** | Time stops and resumes |
| Go faster | **2×**, **3×**, **5×** | Time passes faster; the physics is identical, only pacing changes |
| Jump ahead 15 minutes | **Forward** | The engine simulates forward to the new time |
| Jump back 15 minutes | **Back** | The engine restores the last checkpoint and replays to the new time |
| Step one minute | **Step** | Advances exactly one virtual minute and holds |
| Start the day over | **Restart** | After confirmation, back to 00:00:00 with the same seed |
| Switch 12/24-hour time | click the clock | Everywhere in the interface |

Skip ahead to about **08:00**: the morning peak. Roads around schools and
offices turn amber and red as their demand rises. Go back to 06:00 and forward
again: you will see exactly the same thing, because the day is deterministic.

!!! note "Why jumping back is exact"
    Every 15 virtual minutes the engine stores a checkpoint of the whole
    network. Jumping back restores the nearest one and replays the physics in
    one-second steps to the target, so the result is identical to having
    played there. See [Checkpoints and seeking](../concepts/simulation-engine.md#checkpoints-and-seeking).

## 4. Watch events happen

Over the day you will see:

- **Signals** cycling at junctions, in green waves along main roads.
- **Storms** (blue circles) that grow, drift and fade. Roads under heavy rain
  slow down, and low-lying roads can flood and close.
- **Incidents**: at least four a day, such as accidents, breakdowns, closures
  and spills, that slow or shut a road until they clear.
- **Demand** swelling and subsiding around places on weekday or weekend curves.

Each appears in **News** and, for the important ones, as a notification. Turn
on **Auto Focus** (sidebar) and the camera frames each event as it happens. Turn
on **Do Not Disturb** to silence notifications while keeping their history.

The **Queue** list shows what the engine has scheduled next, and **Incidents**
lists what is active now.

## 5. Change the view

Open **Layers** (lower HUD) to switch map layers on and off: roads, vehicles
(the flow dots), buildings, labels, place names, weather. **Places** filters
which kinds of place have markers. Settings holds the rest: time format,
notification behaviour, skip and step intervals, reduced motion. Preferences
stay in this browser; **About → Reset all preferences** restores the
operator's defaults.

## 6. Try a different world

- **The same place on a weekend:** `./launcher start --seed 382923 --day-type weekend`.
  Schools are quiet, shops and leisure busier.
- **Somewhere else:** click the regeneration button next to the seed in the command rail
  (**Generate a new world**). A fresh seed picks a new city; the current world
  stays until the new one is ready, which then starts paused at 00:00:00.
- **A seed of your own:** any number works: `./launcher start --seed 2026`.

## 7. Finish the day and save a report

Let the day run to 24:00:00 (5× gets there in 12 minutes), or jump with »
until it completes. **The day is complete** summarises it: final time, incidents,
rain events, peak congestion, the seed. Choose **Save Report** for a PDF with the
day's timeline, throughput chart and event tables, or **Export Report** in the
top bar at any time.

## 8. Drive it from the API

Everything you just did is an HTTP call. With the run still going:

```bash
curl -s localhost:8090/api/v1/playback/status | python3 -m json.tool | head -20
curl -s -X POST localhost:8090/api/v1/playback/seek -d '{"target_time":"17:30:00"}'
curl -s localhost:8090/api/v1/view/traffic | python3 -m json.tool
```

See the [API guide](../api/index.md).

## Where next

- [Observer interface](../guide/observer-interface.md): every control in detail.
- [Operator CLI](../guide/operator-cli.md): saved seeds, logs, tests.
- [Simulation engine](../concepts/simulation-engine.md): what the model computes each second.
