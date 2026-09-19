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
turns reduced motion on, that is all that is recorded, so a later edit to
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

Which layers the map draws. All boolean. Every layer defaults to `true` except
`labels` and `place_names`, which default to `false`.

| Key | Draws |
| --- | --- |
| `roads` | Road geometry |
| `traffic` | Congestion colouring of roads |
| `vehicles` | Flow markers |
| `signals` | Traffic-signal phase indicators |
| `buildings` | Place markers and footprints |
| `place_names` | Names of places. Independent of `buildings`: off keeps every building drawn and withholds only its name |
| `labels` | Street names. Off by default. Hiding them removes the text only; roads stay drawn |
| `weather` | Rain cells |
| `flooding` | Flood colouring |
| `incidents` | Incident markers |
| `events` | Demand effects |

Street names are removed where the map draws them, not covered by an overlay,
so turning the layer off costs nothing to render.

### `reduce_motion`

`"auto" | "on" | "off"`, default `"auto"`.

`auto` follows the operating system's `prefers-reduced-motion`. An explicit
choice wins over the OS. Adaptive Simulation Backpressure can hold it on while
the interface catches up; the control then shows as held rather than changed.

### `auto_focus`

```json
"auto_focus": { "mode": "enable-force", "strategy": "round-robin", "dwell_seconds": 9, "zoom": 1.6 }
```

| Field | Values | Meaning |
| --- | --- | --- |
| `mode` | `disable` | Off, and the control is unavailable |
| | `enable` | Offered once per run in a dialog: Enable or Disable |
| | `enable-force` *(default)* | On from the start, without asking |
| `strategy` | `round-robin` *(default)* | Visit every live event in turn |
| | `latest` | Stay on the most recently appeared event |
| `dwell_seconds` | 2 to 120, default 9 | How long Round-Robin holds each event |
| `zoom` | 0.2 to 8, default 1.6 | Scale used when focusing on a searched place |

Auto Focus frames each event by its real footprint rather than a fixed zoom:
the road segment of an incident, the disc of a rain cell (re-framed as it
grows), the extent of a flood cluster. With nothing to follow it returns to the
whole network. See [the observer interface guide](observer-interface.md#auto-focus).

The order can be changed at runtime by double-clicking the Auto Focus button,
or in Settings.

### `notifications`

```json
"notifications": {
  "enabled": true,
  "dnd": false,
  "dnd_categories": ["weather", "flooding", "incident", "traffic", "demand", "signals", "system"],
  "dnd_severities": [],
  "max_visible": 3,
  "dwell_ms": 7000
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | Show notifications at all |
| `dnd` | Do Not Disturb. When on, notifications in the muted categories and severities are not shown |
| `dnd_categories` | Categories muted while DND is on. Any of `weather`, `flooding`, `incident`, `traffic`, `demand`, `signals`, `system`. Unknown values are dropped |
| `dnd_severities` | Severities muted while DND is on: `info`, `warning`, `alert` |
| `dwell_ms` | 1000 to 60000. How long a notification remains before it expires. An expanded notification does not expire while open |
| `max_visible` | Retained for compatibility; the capsule shows one notification and counts the rest |

Do Not Disturb affects presentation only. Muted events are still generated,
logged, listed in the telemetry deck and included in the report. When Auto
Focus moves the camera to an event, that event's notification is shown even if
its category is muted; the exception applies to the focused event only.

### `playback`

```json
"playback": { "skip_seconds": 900, "step_seconds": 60 }
```

| Field | Values | Meaning |
| --- | --- | --- |
| `skip_seconds` | 60, 300, 900 *(default)*, 3600 | Virtual time moved by Back and Forward |
| `step_seconds` | 1, 10, 60 *(default)*, 300 | Virtual time advanced by Step, after which the run holds |

### `clock`

`{ "hour12": false }`. 12 or 24 hour display for every simulation timestamp:
the command rail, telemetry, notifications, dialogs, tooltips and the report.
Clicking the time control switches it.

### `asb`

`{ "enabled": true, "report_interval_ms": 1000 }`. See [ASB](asb.md).

## Where settings appear

| Setting | Control |
| --- | --- |
| Layers | **Layers**, in the lower-left cluster beside the legend |
| Auto Focus on or off | Sidebar button (single click), or Settings |
| Auto Focus order | Sidebar button (double click), or Settings |
| Do Not Disturb | Sidebar button, or Settings, which also holds the muted categories and severities |
| Reduced motion | Sidebar button, or Settings |
| Time format | Click the time control, or Settings |
| Skip and step intervals | Settings |
| Reset layers to operator defaults | **Reset** in the Layers panel |

Every change is stored in this browser as a difference from the operator's
file, so a later edit to `config/ui-config.json` still reaches settings the
viewer never touched. The CLI preflight reports values in this file that the
interface would ignore.
