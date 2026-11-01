# WebFabric

![WebFabric](../assets/brand/webfabric-black.png#only-light){ width="190" }
![WebFabric](../assets/brand/webfabric-white.png#only-dark){ width="190" }

WebFabric is how independent applications appear in the observer. An application is
any program that calls the [Fabric API](../api/fabric-api.md). It registers itself,
declares what it wants on screen as data, and the observer draws it. Source:
`WebKit/src/webfabric/`. To write one, see
[Building applications](../development/webfabric-apps.md).

## How it works

```text
application ──HTTP──▶ Fabric registry ◀──one poll── observer ──▶ controlled slots
     ▲                       │                          │
     └────── events ◀────────┘                          └─ sandboxed frames (optional)
```

The observer polls `GET /api/v1/fabric/state` once a second, with the revision it
already has. An idle poll costs one small response, however many applications exist.

## Slots

The observer owns every slot: placement, limits, order and appearance. An application
names a slot and supplies content. Content is rendered as text from known fields only,
so markup in a label stays visible text, and unknown fields, including style, are
ignored.

| Slot | Appears as | Limit on screen | Capability |
|---|---|---|---|
| `header` | A button in the header | 3 | `ui.header` |
| `status` | A status line over the map | 4, then "+N more" | `ui.status` |
| `map_control` | A button in the map dock | 4 | `ui.map-controls` |
| `indicator` | A mark on an edge of the map | 8 | `ui.indicators` |
| `overlay` | Shapes on the map | 16 | `ui.overlays` |
| `panel` | A side panel, one open at a time | 32 | `ui.panels` |
| `sidebar` | Room beside the map for an application's work. The map refits around it; several share it by tabs, and a person can put it away | 8 | `ui.sidebar` |
| `deck` | A section of the telemetry deck on the right, under its own tab | 8 | `ui.deck` |
| `dialog` | A dialog, one at a time, when nothing else is | 1 | `ui.dialogs` |

Limits are shared, in registration order, so a conflict resolves the same way every
time and no application can push another off screen by updating more often.

Applications name **tones** (`neutral`, `accent`, `ok`, `warn`, `danger`) and numbered
**series** (0 to 7, for things like bus lines), never colours. Fabric refuses anything
else, so light mode and colour-vision palettes reach application content by themselves. Branding, tokens and legal text are not
reachable from any declaration, and the reserved names `dstns`, `fabric` and
`webfabric` cannot be registered. Every notification is marked as coming from WebFabric, with the name of the
application that sent it and a design of its own, and every dialog says who it is from.

## Motion

An element's `motion` chooses how it arrives: `none`, `fade`, `rise`, `slide`, `scale`, `pop`
or `drop`, or a custom `{"stiffness": k, "damping": c}`. Custom springs must keep to the guidelines,
and Fabric refuses others: stiffness in [40, 1200], overshoot under 12%, and settled within 1.5 s, so
nothing feels out of place. On an overlay, a custom spring is also how its named points glide.

## On the road network

Overlay features can name parts of the road network instead of coordinates, so they stay on
the roads. They use the node and edge IDs from `GET /api/v1/view/topology`.

| Feature | Required | Options |
|---|---|---|
| `marker` | `node` | `shape`: `pin`, `stop`, `ring` or `diamond`; `size`, `label` |
| `entity` | `edge` | `at` (0 to 1 along the edge), `shape`: `bus`, `vehicle` or `dot`; `size`, `label`. With an `id` it glides between reports, facing along the road |
| `route` | `nodes` | Adjacent junctions in order, drawn along the real road shape; `width`, `dash`. With `draw_s` it draws itself along the road over that many seconds |
| `path` | `id`, `nodes` | The same route, animated. See below |

A `path` is played by the observer, so an application declares it once and sends nothing per
frame.

| Option | Default | Meaning |
|---|---|---|
| `speed_mps` | 40 | Metres of map per second of real time, 1 to 1000 |
| `loop` | false | Play again from the start |
| `bounce` | false | Turn round at each end. With `loop` it continues; without, it finishes back at the start |
| `dwell_s` | 0 | Time held at each junction on the way, and at the ends, up to 60 |
| `delay_s` | 0 | Time before it sets off, up to 600 |
| `spring` | `standard` | `smooth`, `standard`, `lively` or `snappy`, or a custom spring within the motion guidelines |
| `shape` | `bus` | `bus`, `vehicle`, `dot` or `none` |
| `reveal` | true | Draw the line as it travels |
| `trail` | true | Keep the whole line faintly visible beneath it |
| `paused` | false | Hold where it is |
| `run` | 0 | Change this number to play it again |
| `draw_s` | | Draw the line along the road over this many seconds, up to 600, rather than at `speed_mps` |
| `drive` | false | Drive it as the map's own traffic does: pull away, brake, keep to its side of the road, with brake lights. `spring` then has no effect |
| `obey_signals` | true | With `drive`, wait at junctions where the core's signal is red |
| `count` | 1 | With `drive`, how many vehicles run in a convoy, up to 12 |
| `spacing_m` | 14 | With `drive`, how far apart a convoy keeps, 2 to 200 |

The entity follows a guide that travels at the path's speed and holds at junctions. The spring
is what shapes how it pulls away and settles. With reduced motion on, the route is shown whole and nothing
travels.

Every junction in `nodes` must have a road to the next. A sequence that is not adjacent is not drawn in part: the
element is refused.

Fabric checks what it can when the UI is declared. A shape or range it does not offer is refused with
`400 INVALID_ELEMENT`. A node or edge the loaded world does not have, or a `nodes` sequence with no road
from one junction to the next, is refused with `422 NOT_ON_NETWORK`. If the world is replaced afterwards, the
observer leaves out whatever no longer exists. Roads are directed, so a two-way street is two edges.

## Widgets of its own

Besides the general widgets, two exist for this kind of application. `route` lists `stops` in order, each
with a `label`, optional `caption` and a `state` of `passed`, `current` or `next`. `sparkline` shows a
`label`, a `value` and recent `values`, in a `series` or `tone`.

## Where it lives

The server side is in `Fabric/src/webfabric/` (`routes.cpp`, `registry.cpp`) and
`Fabric/include/dstns/webfabric/`. The observer's side, which draws what is declared, is in
`WebKit/src/webfabric/`. A worked example is `Fabric/examples/bus_planner.py`.

## Isolation

| Boundary | What it gives |
|---|---|
| Declarative slots | An application's data never becomes markup or code in the page |
| Sandboxed frames | A panel's own page runs with `sandbox="allow-scripts"` and no `allow-same-origin`. It has an opaque origin, so the browser denies it this page's DOM, storage and cookies, and the server refuses it |
| Capability-checked bridge | A frame can only post messages. Each is checked against what its application has been granted |
| Error boundaries | A fault while drawing one application hides that application and reports it; the rest of the interface carries on |
| Content Security Policy | The observer's own page loads scripts only from this server |
| Leases | An application that stops checking in is suspended, then unloaded, and its UI goes with it |

See [what this does not protect](../deployment/security.md#applications).

!!! note "A limit of frames"
    A sandboxed frame may share a thread with the page in some browsers, so a frame in
    a tight loop can slow the interface even though it cannot reach it. Keep heavy work
    in the application's own process, or in a worker inside the frame.

## Settings

**Settings → Applications → WebFabric** lists registered applications, with search.
One application is on screen at a time, so any number stays navigable. Each has its
settings, drawn from its schema with the same controls as the rest of Settings; its
permissions; and details including state, recorded actions, suspend, resume and
forget. A separate list shows applications waiting for permission.

Unlike the observer's own presentation preferences, which stay in each browser,
application settings live on the server, because the application has to read them.
Each is reachable only with that application's token or from the observer.

## Performance

| Rule | Why |
|---|---|
| One poll for all applications | Twelve applications cost the same as one |
| After the first poll, only changes travel | An application moving its buses resends one element, not its network |
| Named overlay points glide | A bus reported once a second moves on a spring between reports |
| Declared UI is state and coalesces | A thousand updates between polls are one render of the latest value |
| Unchanged elements keep their identity | Memoised components skip them, so one application updating does not redraw the others |
| Overlays redraw outside React | A camera move does not re-render the shell |
| Events are lossless | Notifications and actions use cursors, and a flood is refused with `RATE_LIMITED`, never dropped silently |
| Frames follow the observer | They receive the simulation summary once per delivered snapshot, latest only |

Measured in Chrome with twelve applications, each updating as fast as the server would
answer: over 20,000 updates in six seconds held 60 fps, with a 95th-percentile frame of
16.8 ms and no long tasks (`WebKit/tests/browser-webfabric.mjs`). That is a headless
run on an Apple silicon laptop, so treat it as a comparison rather than a promise.

## Licence

WebFabric is part of DSTNS, © 2026 Varun Karthic, under
[AGPL-3.0-or-later](../license.md). Applications are independent; see
[Applications and the licence](../license.md#applications-and-the-licence).
