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
| `ui.header`, `ui.status`, `ui.panels`, `ui.overlays`, `ui.map-controls`, `ui.indicators` | Those [slots](../components/webfabric.md#slots) | Automatically |
| `ui.notifications` | Sending notifications; Do Not Disturb still applies | Automatically |
| `settings` | Changing your own settings | Automatically |
| `sim.read` | The simulation summary in your frames | Automatically |
| `ui.dialogs` | Interrupting with a dialog | By a person |
| `ui.frames` | Showing your own page in a sandboxed frame | By a person |
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

## Be a good neighbour

- Update a status element rather than sending notifications for anything frequent.
  Notifications are limited to about 20 a second, and past that you get `429`.
- Update one element with `PUT .../ui/{element}` rather than resending everything.
- Declared UI is limited to 64 elements and 512 KiB per application.
- Handle `409 APP_NOT_ACTIVE`: a person may have suspended you.

Your application is your own work. See
[Applications and the licence](../license.md#applications-and-the-licence).
