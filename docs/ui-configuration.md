# Observer configuration

Everything the interface starts with lives in `config/ui-config.json`. Every
value is **presentation only**: nothing in this file changes what the simulation
computes, and none of it is ever sent to the core.

## Resolution order

Three layers, innermost first. Each one only overrides what it actually sets.

| Layer | Source | Purpose |
| --- | --- | --- |
| 1. Built-in | `ui-engine/src/uiConfig.ts` → `BUILT_IN` | The interface always has a complete, valid configuration, even with no server |
| 2. Operator | `config/ui-config.json`, served at `/api/v1/system/ui-config` | The defaults for this deployment |
| 3. Viewer | `localStorage["dstns.ui-config.v1"]` | This person's own choices |

**Viewer overrides are stored as deltas**, not as a full snapshot. If a viewer
turns reduced motion on, that is all that is recorded — so a later edit to
`config/ui-config.json` still reaches every field they never touched. Returning
every setting to its default clears the entry entirely.

A missing, unreachable or malformed file is not fatal. `mergeConfig()`
range-checks every value and ignores unknown keys, so a hand-edited file that
gets one field wrong degrades to the default *for that field* rather than
breaking the interface. A file that is not valid JSON at all is reported by the
core as `UI_CONFIG_INVALID` and the interface falls back to its built-in
defaults.

## Reference

### `layers`

Which layers the map draws. All boolean, all default `true` except where noted.

| Key | Draws |
| --- | --- |
| `roads` | Road geometry and its congestion colouring |
| `signals` | Traffic-signal phase indicators |
| `labels` | Street names |
| `place_names` | Names of places. **Independent of `buildings`**: switching this off keeps every building drawn and withholds only its name, so the map keeps its shape without the clutter |
| `traffic` | Congestion colouring of roads |
| `vehicles` | Flow markers |
| `buildings` | Place markers and footprints |
| `weather` | Weather cells and rain |
| `flooding` | Flood hazard colouring |
| `incidents` | Incident markers |
| `events` | Demand-event effects |

### `reduce_motion`

`"auto" | "on" | "off"` — default `"auto"`.

`auto` follows the operating system's `prefers-reduced-motion`. An explicit
choice wins over the OS. ASB can force it on temporarily; while it does, the
control shows as locked rather than simply changed.

### `auto_focus`

```json
"auto_focus": { "mode": "enable", "strategy": "round-robin", "dwell_seconds": 9, "zoom": 1.6 }
```

| Field | Values | Meaning |
| --- | --- | --- |
| `mode` | `disable` | Off, and the control is unavailable |
| | `enable` *(default)* | Offered once per run in a dialog: Enable or Disable |
| | `enable-force` | On from the start, without asking |
| `strategy` | `round-robin` *(default)* | Cycle through every live event in turn |
| | `latest` | Always follow the most recent event |
| `dwell_seconds` | 2–120, default 9 | How long Round-Robin holds each event |
| `zoom` | 0.2–8, default 1.6 | Scale the camera settles at |

The strategy can also be changed at runtime: **double-click** the auto-focus
button in the map dock.

Auto-focus follows real disruption only — incidents, flooding and weather cells.
Traffic signals are deliberately excluded: they change constantly and would make
the camera twitch. Any manual pan or zoom cancels an in-flight glide
immediately.

### `notifications`

```json
"notifications": { "enabled": true, "dnd": false, "max_visible": 3, "dwell_ms": 7000 }
```

`dnd` is do-not-disturb: notifications stop appearing on screen, while events
are still recorded and stay readable in the telemetry deck. It is also a button
in the map dock.

### `clock`

`{ "hour12": false }` — 12- or 24-hour virtual clock. Clicking the clock in the
playback dock switches it.

### `asb`

`{ "enabled": true, "report_interval_ms": 1000 }` — see [ASB](asb.md).

## Where settings appear

| Setting | Control |
| --- | --- |
| Layers | **Display Layers** in the control strip |
| Reduced motion | Map dock, directly below auto-focus |
| Auto-focus on/off | Map dock — single click |
| Auto-focus strategy | Map dock — double click |
| Do not disturb | Map dock |
| Clock format | Click the clock in the playback dock |
| Reset to operator defaults | **Reset** in the Display Layers panel |
