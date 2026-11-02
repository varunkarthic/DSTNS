# Building applications

A WebFabric application is any program that can make HTTP requests. Nothing is
installed: it calls the API, registers itself, and appears. This page is the working
guide; the [Fabric API](../api/fabric-api.md) lists every route.

## A complete application

Run this while DSTNS is running. It needs only Python's standard library.

```python
--8<-- "docs/development/example_app.py"
```

It shows a status line, a panel with a button, and a setting. Open **Settings →
Applications → WebFabric** to change the setting, and watch the application print it
without restarting.

## Lifecycle

```text
registered ──▶ initialized ──▶ active ◀──▶ suspended
     │              │            │  ▲          │
     └──────────────┴─▶ failed ◀─┘  └ recovers │
                           │                   │
                           └────▶ unloaded ◀───┘
```

| State | Means | Entered by |
|---|---|---|
| `registered` | Known, and its UI is shown | `POST /fabric/apps` |
| `initialized` | Ready, but not yet working | The application, through `PUT .../state` |
| `active` | Working | A heartbeat, or `PUT .../state` |
| `suspended` | Hidden. Calls are refused where they would act | A person in Settings, or a lapsed lease |
| `failed` | Hidden, and reported in Settings | `PUT .../state`, a drawing fault, or a frame that never answers |
| `unloaded` | Gone; its UI is removed | `DELETE`, or five lapsed leases. Identity, grants and settings remain |

Send a heartbeat more often than `lease_s` (default 60). Any call with the token also
counts. A lapsed lease recovers with the next call. Once unloaded, register again.

**Keep your token.** It proves an ID is yours. Presenting it re-registers and keeps
your grants and settings across restarts of either side. Without it, a live ID answers
`409 APP_ID_CONFLICT`. An ID that has left may be taken again only if it holds no
granted permissions, otherwise a person must forget it in Settings first.

## Capabilities

Request what you need in the manifest. Those marked automatic are granted at
registration, because they only add to your own surfaces. The rest wait for a person,
and anything that depends on them stays hidden until then (`blocked_ui`).

| Capability | Allows | Granted |
|---|---|---|
| `ui.header`, `ui.status`, `ui.panels`, `ui.sidebar`, `ui.deck`, `ui.overlays`, `ui.map-controls`, `ui.indicators` | Those [slots](../components/webfabric.md#slots) | Automatically |
| `ui.notifications` | Sending notifications; Do Not Disturb still applies | Automatically |
| `settings` | Changing your own settings | Automatically |
| `sim.read` | The simulation summary in your frames | Automatically |
| `ui.dialogs` | Interrupting with a dialog | By a person |
| `ui.frames` | Showing your own page in a sandboxed frame | By a person |
| `ui.camera` | Asking the map to move: where, and how close | By a person |
| `ui.layers` | Holding layers and places on or off | By a person |
| `control.playback` | Pause, resume, seek, step, speed, reset | By a person |
| `control.events` | Injecting events and overrides, which **changes results** | By a person |
| `control.world` | Replacing the world | By a person |

Starting runs and terminating the server are never offered to applications.

Reading the simulation needs no capability from a program outside the browser: use the
[View API](../api/view-api.md) as any other client does.

## Settings

```json
{
  "version": 2,
  "groups": [{ "id": "general", "label": "General", "fields": [
    { "id": "enabled", "label": "Enabled", "type": "toggle", "default": true },
    { "id": "rate", "label": "Rate", "hint": "Samples per minute.", "type": "slider", "min": 0, "max": 100, "step": 5, "default": 25 },
    { "id": "limit", "label": "Limit", "type": "number", "min": 1, "default": 10 },
    { "id": "mode", "label": "Mode", "type": "select", "default": "fast",
      "options": [{ "value": "fast", "label": "Fast" }, { "value": "safe", "label": "Safe" }] },
    { "id": "name", "label": "Name", "type": "text", "max_length": 40, "default": "" }
  ]}],
  "migrations": { "1": { "rename": { "speed": "rate" } } }
}
```

- Every field needs a valid `default`. Changes are validated, and a request applies
  completely or not at all.
- Changes reach you as `settings.changed` events, so you need not restart.
- Raising `version` migrates what is stored: declared renames apply one version at a
  time, values still valid are kept, and anything else returns to its default. You
  receive `settings.migrated`.
- Settings stay after you unload, and are removed when a person forgets you.

## Your own page

A panel may show your own page instead of widgets, with the `ui.frames` capability:

```json
{ "id": "main", "slot": "panel", "title": "Lab", "frame": "https://lab.example/panel" }
```

The page runs in a sandbox with an opaque origin, and cannot call the API. It talks to
the observer by message. Serve it over `https` if the observer is behind the TLS gateway,
or the browser will block it as mixed content.

```js
parent.postMessage({ fabric: 1, type: "ready" }, "*");          // Required within 10 s.
parent.postMessage({ fabric: 1, id: 1, type: "settings.get" }, "*");
parent.postMessage({ fabric: 1, id: 2, type: "settings.set", changes: { rate: 50 } }, "*");
parent.postMessage({ fabric: 1, id: 3, type: "sim.subscribe" }, "*");
parent.postMessage({ fabric: 1, id: 4, type: "action", element: "run", value: 1 }, "*");

addEventListener("message", ({ data }) => {
  // { type: "init" | "settings" | "sim" | "ok" | "error", id?, ... }
  if (data.type === "error") console.warn(data.code, data.message);
});
```

## Directing the view

With a person's grant, an application can direct what's on screen: show a junction, fit a route, turn on the traffic
layer for a moment, hide the schools. It can't change anyone's settings. It asks, and the observer decides.

```python
# Needs "ui.camera" and "ui.layers" in the manifest, and a person's grant.
call("POST", f"/fabric/apps/{app}/view", {"action": "node", "node": 42, "span_m": 800})
call("POST", f"/fabric/apps/{app}/view", {"action": "zoom", "factor": 0.5})

call("PUT", f"/fabric/apps/{app}/presentation", {"layers": {"traffic": True, "weather": False}, "places": {"school": False}})
call("DELETE", f"/fabric/apps/{app}/presentation")
```

Your own routes and paths can choose how they look, with no further grant:

```python
{"type": "path", "id": "line-1", "nodes": line, "color": "auto", "style": "flow", "glow": True, "speed_mps": 18, "trail": True}
```

Write for being told no. A person who has just moved the map keeps it for 8 seconds, and you'll get
`view.declined` with the reason. Asking again and again won't help, and running out of the allowance gets a `429`.
Move the view when something has happened that's worth moving it for, and say why in a status or a note.
The [API reference](../api/fabric-api.md#directing-the-view) has the whole of it.

## A planner beside the map

An application with real work to show, such as a bus network planner, takes the `sidebar` slot:
tabs for its algorithms, lines as a `list`, a `legend` with switches, and its network as
an `overlay` using `series` colours. Keep the network and the vehicles in separate overlay
elements: the vehicles can then update every second, as named points that glide, without
resending the network. A button with `pick: true` asks a person for a place on the map.

To follow the roads, name them rather than coordinates. A `route` draws adjacent junctions, a `marker`
stands on a junction, an `entity` sits on an edge, and a `path` animates along adjacent junctions with no
further requests:

```python
fabric.app("PUT", "/ui/buses", {"slot": "overlay", "features": [
    {"type": "route", "nodes": line, "series": 0, "width": 3},
    {"type": "marker", "node": line[0], "shape": "stop", "series": 0},
    {"type": "entity", "edge": depot_edge, "at": 0.5, "shape": "vehicle", "tone": "neutral"},
    {"type": "path", "id": "bus-1", "nodes": line, "series": 0, "shape": "bus", "label": "R1",
     "speed_mps": 60, "spring": "lively", "loop": True, "bounce": True, "dwell_s": 1.2},
]})
```

Two more things come with no further requests. `"draw_s": 2` on a `route` or `path` draws it along the road over two
seconds, which is what a planner uses to show a line being found. `"drive": True` on a `path` gives its vehicles the same
driving as the map's own traffic: they pull away and brake, keep their distance in a convoy of `count`, show brake lights
and wait at red signals:

```python
fabric.app("PUT", "/ui/found", {"slot": "overlay", "features": [
    {"type": "route", "nodes": line, "series": 1, "width": 4, "draw_s": 2.5},
    {"type": "path", "id": "convoy", "nodes": line, "drive": True, "shape": "vehicle", "count": 4,
     "speed_mps": 30, "loop": True, "reveal": False, "trail": False, "tone": "accent"},
]})
```

Every option is listed under [On the road network](../components/webfabric.md#on-the-road-network).

`Fabric/examples/bus_planner.py` does all of this and can be run against any world. It uses DSTNS's own
stops where a district has enough, otherwise naming well-connected junctions as stops, and shows the
demand at them in a section on the right.

## Be a good neighbour

- Update a status element rather than sending notifications for anything frequent.
  Notifications are limited to about 20 a second, and past that you get `429`.
- Update one element with `PUT .../ui/{element}` rather than resending everything.
- Declared UI is limited to 64 elements and 4 MiB per application.
- Handle `409 APP_NOT_ACTIVE`: a person may have suspended you.

Your application is your own work. See
[Applications and the licence](../license.md#applications-and-the-licence).
