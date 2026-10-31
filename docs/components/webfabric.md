# WebFabric

![WebFabric](../assets/brand/webfabric-black.png#only-light){ width="190" }
![WebFabric](../assets/brand/webfabric-white.png#only-dark){ width="190" }

WebFabric is how independent applications appear in the observer. An application is
any program that calls the [Fabric API](../api/fabric-api.md). It registers itself,
declares what it wants on screen as data, and the observer draws it. Source:
`ui-engine/src/webfabric/`. To write one, see
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
| `dialog` | A dialog, one at a time, when nothing else is | 1 | `ui.dialogs` |

Limits are shared, in registration order, so a conflict resolves the same way every
time and no application can push another off screen by updating more often.

Applications name **tones** (`neutral`, `accent`, `ok`, `warn`, `danger`), never
colours. Fabric refuses anything else. Branding, tokens and legal text are not
reachable from any declaration, and the reserved names `dstns`, `fabric` and
`webfabric` cannot be registered. Every notification is prefixed with the name of the
application that sent it, and every dialog says who it is from.

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
| Declared UI is state and coalesces | A thousand updates between polls are one render of the latest value |
| Unchanged elements keep their identity | Memoised components skip them, so one application updating does not redraw the others |
| Overlays redraw outside React | A camera move does not re-render the shell |
| Events are lossless | Notifications and actions use cursors, and a flood is refused with `RATE_LIMITED`, never dropped silently |
| Frames follow the observer | They receive the simulation summary once per delivered snapshot, latest only |

Measured in Chrome with twelve applications, each updating as fast as the server would
answer: over 20,000 updates in six seconds held 60 fps, with a 95th-percentile frame of
16.8 ms and no long tasks (`ui-engine/tests/browser-webfabric.mjs`). That is a headless
run on an Apple silicon laptop, so treat it as a comparison rather than a promise.

## Licence

WebFabric is part of DSTNS, © 2026 Varun Karthic, under
[AGPL-3.0-or-later](../license.md). Applications are independent; see
[Applications and the licence](../license.md#applications-and-the-licence).
