# Observer Interface

This guide describes the DSTNS observer interface in `ui-engine/`: what each
control does, how it connects to the simulation core, and how the parts are
built. It is written for operators using the interface and for engineers
changing it.

Related references: [configuration](ui-configuration.md), [API](api.md),
[Adaptive Simulation Backpressure](asb.md), [testing](TESTING.md).

## Contents

1. [Start-up](#start-up)
2. [Layout](#layout)
3. [Command rail](#command-rail)
4. [Time and progress](#time-and-progress)
5. [Speed](#speed)
6. [Seed and new worlds](#seed-and-new-worlds)
7. [Runtime status](#runtime-status)
8. [Notifications](#notifications)
9. [Do Not Disturb](#do-not-disturb)
10. [Auto Focus](#auto-focus)
11. [Sidebar and settings](#sidebar-and-settings)
12. [Layers and legends](#layers-and-legends)
13. [Telemetry](#telemetry)
14. [Tooltips](#tooltips)
15. [Tutorial](#tutorial)
16. [Simulation complete](#simulation-complete)
17. [Report](#report)
18. [Minimum screen size](#minimum-screen-size)
19. [Dialogs, errors and empty states](#dialogs-errors-and-empty-states)
20. [Motion](#motion)
21. [Accessibility](#accessibility)
22. [Architecture](#architecture)
23. [Performance](#performance)
24. [Verification](#verification)

## Start-up

The interface opens first and the world is prepared behind it. The CLI starts
the core, opens the browser, waits for the page to be served
(`GET /system/observer`), and only then requests the run, so the wait is spent
watching the interface report what is happening rather than a blank tab.

The start-up screen shows the stages the core actually reports, in order:

| Stage | Entered when |
|---|---|
| Starting interface | before the first status arrives |
| Selecting world | the compile is resolving the seed to a place |
| Downloading map | a map is being requested, downloaded or validated |
| Generating world | the graph, signals and schedules are being built |
| Initializing simulation | the run exists and the first network is arriving |

`GET /system/map-status` carries both the live download figures and, in
`preparation`, what the compile is doing; it stays readable while a compile
holds the engine lock, which is what lets the interface follow a blocking
preparation. A percentage is shown only for a download whose total size the
core knows. Nothing is invented: when no run has been started the screen says
so and shows no progress at all.

The mark draws itself, the stages settle in beneath it, and once the first
network arrives the screen dissolves while the map renders behind it, with the
instrumentation fading up in place. The same surface, in an overlay form, is
used for world generation and for failures.

## Layout

The map fills the window. Floating instrumentation sits over it:

```text
+--------------------------------------------------------------------------+
| DSTNS                         [City]  Tutorial  Export Report  (i)       |
+----+---------------------------------------------------+-----------------+
| +  |                                                   | LIVE TELEMETRY  |
| -  |                                                   | tiles           |
| [] |                      map                          | Stack News      |
| Q  |                                                   | Queue Incidents |
| AF |                                                   |                 |
| DND|                                                   |                 |
| RM |                                                   |                 |
| ⚙  | [Notification +2]  [Layers] [Roads] [Places]      [coords] [scale] |
+----+ ( ⟲ | « ▸| ▶ » ) ( 08:42:17 ) (0.25 … 10×) SEED 17310766… ↻ ● Online  Terminate |
+--------------------------------------------------------------------------+
```

- **Sidebar** (left): zoom, fit, place search, Auto Focus, Do Not Disturb,
  reduced motion, and Settings.
- **Telemetry** (right): live measures and the Stack, News, Queue, Incidents
  and Notifications lists. It stops above the command rail and collapses to a
  narrow strip. Below 1024 px only the strip is docked.
- **Lower HUD**: three zones above the rail. Notifications on the left, the
  Layers button and the road and place legends in the centre, coordinates and
  the scale bar on the right. The zones never overlap each other, the rail, the
  map tools or telemetry; which elements become compact is decided by the
  width of the HUD itself, not the window, so collapsing telemetry gives the
  legends their full form back.
- **Command rail** (bottom): the simulation controls, centred across the full
  width.

The map frames the network inside the region these panels leave free, using
`mapInsets()` in `src/mapProjection.ts`. The same insets are used when Auto
Focus frames an event, so a focused event is never hidden under a panel.

## Command rail

`src/CommandRail.tsx`. One rounded bar, about 60 px tall:

| Group | Controls |
|---|---|
| Playback | Reset, Back, Step, Play/Pause, Forward |
| Time | Time and progress control |
| Speed | 0.25×, 0.5×, 1×, 2×, 3×, 5× |
| Session | Seed with copy and Generate New World, runtime status, Terminate |

Every control is a real engine operation:

| Control | Request | Engine behaviour |
|---|---|---|
| Play / Pause | `POST /playback/play`, `/pause` | Starts or stops virtual time |
| Back | `POST /playback/seek` to now minus the skip interval | Restores the nearest 15-minute checkpoint and replays deterministically to the target |
| Forward | `POST /playback/seek` to now plus the skip interval | Advances the physics to the target |
| Step | `POST /playback/step` with the step interval | Advances exactly that much and holds paused |
| Reset | Confirm, then `POST /playback/seek` to 0 | Same scenario from 00:00:00 |
| Speed | `PUT /control/tick-rate` | Changes the applied rate |
| Terminate | Confirm, then `POST /system/terminate` | Stops the run and the server |

Back and Forward keep the current play state. Step always leaves the run
paused; a step that reaches 24:00:00 completes the run. The skip interval
(default 15 minutes) and the step interval (default 1 minute) are set in
Settings or in `config/ui-config.json` under `playback`.

Back is disabled at 00:00:00, Forward and Step at 24:00:00, and Play/Pause
unless the run is running or paused. All controls are disabled while data is
stale, while the interface is suspended by backpressure, and while a new world
is being generated.

The Play/Pause button is slightly larger and filled, as the primary state. Its
glyph swaps with a short rotation.

## Time and progress

The time control is a stadium-shaped button showing the current simulation
time. Its outline is the completion indicator: the illuminated share of the
perimeter equals the share of the virtual day completed, starting at the top
centre and running clockwise. The outline is drawn with `pathLength=100`, so
42% complete is a dash of exactly 42 units.

- **Hover or keyboard focus** reveals "42% complete" above the control.
- **Click** switches between 12 and 24 hour time everywhere.
- **Paused**: the outline and time breathe slowly (2.6 s cycle, opacity only).
  With reduced motion the animation stops and the time is shown dimmed.

The accessible name carries the time, percentage and paused state, for example
"Simulation time 08:42:17, 36 percent complete, paused".

### 12 and 24 hour time

There is one preference, `clock.hour12`, and one formatter module,
`src/timeFormat.ts`. State always holds canonical virtual seconds; formatting
happens at display time through the `useTimeFormat()` hook
(`src/preferences.tsx`). Every timestamp uses it: the rail, telemetry lists,
notifications, the completion dialog, tooltips and the report.

Messages composed by the core contain clock times as text ("Rain storm
scheduled at 16:45:00"). `localizeTimes()` rewrites valid clock times inside
such text, so they follow the preference too. Midnight at the end of the day is
"24:00:00" in 24 hour mode and "12:00:00 AM" in 12 hour mode.

## Speed

A segmented control with a sliding highlight, offering exactly 0.25×, 0.5×,
1×, 2×, 3×, 5× and 10×. It is a `radiogroup`: arrow keys, Home and End move the
selection and send the new rate. The core accepts any rate in (0, 10].

Every label sits on one baseline in a segment of the same width, and the weight
does not change with selection, so nothing shifts when the choice moves. The
highlight is placed over the *measured* segment of the nearest offered rate
(`pillGeometry()`), not from an assumed segment width, so it stays aligned at
every window size; it moves in 170 ms. When backpressure lowers the applied
rate the highlight follows it and turns amber, and the requested rate keeps a
dotted amber underline. When backpressure locks the rate at 1× the control is
disabled and shows a lock badge.

## Seed and new worlds

The seed is a number, and it is the same number end to end: what the operator
types on the command line, what names the run, what the interface shows, and
what reproduces the world. A generated seed is 64 bits, so it is short enough
to read off the screen and retype; a typed seed may be up to 128 bits and is
then shortened in the middle for display. The core's hexadecimal form is an
internal detail, reported as `global_seed` for provenance and never presented
as the seed's name.

The seed is always visible. Clicking copies the whole number to the clipboard
and shows "Copied" in place for 1.6 s ("Copy failed" if the browser refuses).
Copying is local and sends nothing to the core.

The arrows beside the seed generate a new world.

### Lifecycle

1. **Confirm.** Replacing the world discards the current run, so a dialog asks
   first and explains that the current simulation keeps running until the new
   world is ready and that the new world starts paused.
2. **Request.** `POST /api/v1/world/regenerate` with the current run id as a
   guard. The core picks a secure seed and copies the rest of the
   configuration from the running scenario. The observer cannot choose
   parameters; scenario configuration stays with the CLI. For a seed-selected
   map the new seed selects its own district; a pinned map file stays pinned.
3. **Progress.** The overlay polls `GET /api/v1/world/status` every 400 ms and
   shows the stages the core reports:

   | Step | Core stages | Detail shown |
   |---|---|---|
   | Generating seed | before the first status | "Requesting a new seed" |
   | Preparing map data | `compiling`, `requesting`, `downloading`, `validating` | City and real bytes; a percentage bar only when the download size is known |
   | Building road network | `building` | Graph, signals and schedules |
   | Initializing simulation | `installing`, and `ready` until the map arrives | Starting the new world |
   | Ready | `ready` with the new map loaded | Shown briefly, then the overlay fades |

   No percentage is invented: stage progress is shown as steps, and a bar
   appears only for downloads with a known size.
4. **Swap.** The core compiles the new world without holding the engine lock,
   then installs it atomically. The interface notices the new run id, loads the
   topology, clears notifications, dismissed state and manual camera requests,
   closes open panels and dialogs, updates the seed, and fits the new network.
   The map layer fades and sharpens in over 700 ms.
5. **Ready.** The new world is paused at 00:00:00 with the operator's requested
   speed.

### Failure

If generation fails the overlay shows a short reason, never a stack trace, and
states that the previous world is still running and unchanged. **Retry** makes
a fresh request; **Return to current world** closes the overlay. Technical
details go to the browser console. The core guarantees the previous world is
untouched because the new one is compiled separately and only installed on
success.

Operators can disable regeneration with `DSTNS_DISABLE_WORLD_REGENERATION=1`;
the control is then disabled.

## Runtime status

The rail shows **Online**, **Degraded** or **Offline** instead of a raw update
rate (`runtimeStatus()` in `src/telemetryRecorder.ts`):

| Status | Condition |
|---|---|
| Online | Data is current and backpressure is not intervening |
| Degraded | Data is stale, or backpressure is Restricted or Async, is holding the speed below the request, or reports the interface out of sync |
| Offline | The core cannot be reached or returned an error |

Its tooltip lists the measured throughput, snapshots per second, request round
trip and any backpressure intervention. The deck header shows the same status.

## Notifications

### Model

`src/notificationModel.ts` turns core news into structured records:

| Field | Meaning |
|---|---|
| `id` | Group identity |
| `type`, `category`, `severity` | Template, taxonomy category, worst severity in the group |
| `timestamp`, `startedAt` | Newest and oldest virtual second |
| `title`, `summary` | Plain-language first layer |
| `details` | Operator facts: severity, road, radius, expected clearance |
| `technical` | Raw fields: event id, news id, template, data |
| `location`, `coordinates` | District and position |
| `focusKey` | The Auto Focus target it describes |
| `count`, `newsIds` | Group size and members |

The first layer never leads with identifiers or telemetry. For example:

| Core message | Notification |
|---|---|
| Rain storm initiated at Node 412 (Radius: 1400m, Intensity: 83%) | **Heavy rain.** Heavy rainfall has developed over the north-east district near Harbour Road. |
| Multi-vehicle collision: lane blocked ... on Edge #1710 near Node #88. (HIGH SEVERITY) | **Collision.** Multi-vehicle collision on Harbour Road. Lane blocked, emergency services on scene. |
| 40 × Flooding detected on Edge N | **Flooding.** Flooding is affecting 40 roads. |

Districts are compass sectors of the network ("the north-east district",
"the central district"); roads are real street names where the map has them.

Notifications are raised for rain start, peak and end, flooding, incident start
and clearance, demand changes and demand surges. Bursts of the same kind are
grouped.

### Capsule

`src/NotificationCapsule.tsx`. One fixed-height (48 px) capsule in the lower
HUD shows the most relevant notification: the Auto Focus event first, then
the most severe, then the newest. The others are counted in a `+N` badge that
updates live.

Clicking expands the same card upward in place (320 ms): the full summary, the
facts, a collapsed **Technical details** section, and a list of the other
current events, any of which can be selected. Escape or a click elsewhere
collapses it. While it is open the list is held steady, so a notification that
would expire cannot vanish while being read. The capsule never covers the
command rail.

## Do Not Disturb

DND is decided in one function, `shouldDisplayNotification()`:

```text
if Auto Focus is on and this is the event Auto Focus is showing: show
else if notifications are disabled: hide
else if DND is off: show
else hide if its category or its severity is muted
```

- Categories come from the core's taxonomy: weather, flooding, incident,
  traffic, demand, signals, system (the core's "control" is folded into
  system). Severities: information, warnings, alerts.
- DND on with the default settings mutes every category.
- DND is presentation only. Muted events are still generated, logged, listed in
  the telemetry deck and included in the report.
- The Auto Focus override applies to the focused event only. When Auto Focus
  moves to an event that has no current notification (because it expired or
  was never raised), `focusNotification()` builds one from live state, so the
  operator always sees why the camera moved. It is marked **Following**.
- Nothing announces what was silenced on the map. The count sits on the
  **Notifications** tab, and the events themselves are there to read.

### History

`src/notificationHistory.ts`. Every notification-worthy event is recorded once,
whether or not its toast was ever shown, with how it was delivered: **Shown**,
**Silenced** (held back by DND), **Notifications off**, or **Before this
session** for events already in the feed when the interface connected. An
event followed by Auto Focus is marked, as is one shown only because of the
Auto Focus override.

The store is keyed by event, so re-rendering, regrouping or replaying after a
seek can never create a second record, and it is bounded at 1,000 entries,
dropping the oldest. Each row carries the title, the time in the global format,
a summary, its flags, and expands to the measured details and the raw technical
fields. The list renders 60 rows at a time behind a **Show earlier** control,
so a long day cannot grow an unbounded DOM. Filters: All, Shown, Silenced and
Auto Focus, each with its count.

## Auto Focus

`src/autoFocus.ts` describes each followable event by its real footprint:

| Event | Geometry | Framing |
|---|---|---|
| Incident | The road segment's polyline | The segment, at least 320 m across |
| Rain cell | Centre and current radius | The whole disc |
| Flooding | Flooded segments, clustered on a 600 m grid with neighbouring cells merged | The cluster's extent |
| Nothing active | The network | The whole network |

`boundsOf()` converts any geometry to bounds; `viewportFor()` fits bounds into
the part of the map not covered by panels, with 18% padding and a minimum span
so a point is not magnified absurdly. The camera glides with an ease-in-out
curve whose duration grows with distance and zoom change (650 ms to 1.4 s),
interpolating zoom geometrically. Any manual pan, zoom or drag cancels a glide.

**Rain follows its growth.** Rain cells expand during the first quarter of
their life and drift with the wind. `framingSignature()` buckets a footprint's
size logarithmically (a new bucket for about every 12% of growth) and its
centre to a quarter of its extent. The camera moves again only when the
signature changes, so it zooms out in steps as the cloud grows instead of
nudging on every snapshot, and the whole cloud stays in view.

**Order.** Round-Robin visits every target in turn, holding each for
`dwell_seconds`. Latest stays on the most recently appeared target. Double-click
the Auto Focus button, or use Settings, to switch.

**No events.** When nothing needs attention the camera returns to the whole
network rather than staying on the last event.

Signals and demand ramps are not followed: they change constantly and would
keep the camera moving for nothing.

## Sidebar and settings

The sidebar holds zoom in, zoom out, fit network, place search, Auto Focus,
Do Not Disturb, reduced motion and Settings. Icons are 18 px (Settings 20 px).
Search opens a field beside the sidebar; results centre the map on the place
and open its inspection card.

**Settings** slides in from the left (320 ms) over the map, stopping above the
command rail. It closes with Escape, the close button, or a click outside.
Sections:

| Section | Settings |
|---|---|
| Auto Focus | Auto Focus Events switch; Round-Robin or Latest |
| Do Not Disturb | Switch; muted categories with descriptions; muted severities; a note on the Auto Focus override |
| Display | 12 or 24 hour time; reduced motion |
| Playback | Back and Forward interval; Step interval |

Each section is a self-contained block in `src/SettingsDrawer.tsx`, so new
settings are added without reorganising the drawer.

## Layers and legends

**Layers** opens a panel above its button. Each row has an icon, a name, a live
count where one exists, and a switch. Arrow keys move between switches;
Escape and outside clicks close it. **All on** enables everything; **Reset**
returns to the operator's defaults.

Street names and place names are off by default. Hiding street names removes
them where the map draws them rather than covering them, and roads stay drawn.
Layers change the picture only; nothing is sent to the core.

**Road legend**: the road-state colours, Clear, Moderate, Severe and Flooded,
inline where the HUD has room and a button with the same swatches where it does
not.

**Place legend**: every marker glyph the map draws, what it stands for, how
many there are, and the demand the core models for it. The taxonomy is
presentation only and lives in `src/mapModel.ts`; whether a place has demand is
never inferred from it. The core reports each feature's `demand_type` (school,
office, mall or store) and the snapshot carries its current multiplier, so the
legend shows "Peak 1.62×", "At rest", or "Not modelled" for kinds the
simulation does not model. Hover cards on the map are built from the same
function, so the two can never disagree.

Places with no DSTNS type, drawn as plain dots, are the bulk of an
OpenStreetMap extract: benches, bicycle parking, stop positions and rail lines,
around 1,300 of 3,500 features in the bundled fixture. They are hidden by
default and enabled either from the legend's footer or from Layers, under
**Unclassified places**. They are hidden from the picture only; the simulation
is unaffected.

## Telemetry

Live Telemetry has two forms of the same data.

**Full panel.** Network measures and the detail tabs below them.

**Collapsed strip.** The panel morphs into a narrow strip on the right edge
that keeps the runtime dot, road edges, vehicles, congestion and weather as
icons with abbreviated figures (`6.2K`, `1.2K`, `37%`), and one button per
list with its count. The glass surface and the contents cross-fade over 280 ms
rather than one disappearing and another appearing, and the map keeps its
position; only the space it may use grows, which Auto Focus picks up on its
next framing.

Clicking a figure or a list opens a **temporary side panel** beside the strip.
Choosing another list changes the panel's contents in place rather than closing
and reopening it, and the full panel stays collapsed. Escape or an outside
click closes it and returns focus to the button that opened it. The collapsed
choice and the open tab are remembered for the next visit.

Compact figures use one formatter (`formatCompact`): exact below a thousand,
then `1.2K`, `12.9K`, `105K`, `1.25M`, never wider than six characters.

Weather is shown as a coloured glyph with one to three filled bars, so
severity is never carried by colour alone, and its accessible name reads
"Weather: Heavy rain, 2 active cells, 6.4 mm/h". The severity is the strongest
active cell, which is the rule the panel has always applied; the core does not
sum overlapping cells.

- Tiles: road edges and those carrying flow, vehicles and halting, incidents
  and closures, weather, and the congestion index.
- **Stack**: one row per subsystem (road network, traffic, weather,
  backpressure, signals) with a 14 px icon in a 26 px tile, a state tag and
  measures.
- **News**: every recorded message with its time.
- **Queue**: upcoming or executed scheduled events, filterable by category.
- **Incidents**: incident and flooding messages in operator language with
  severity tags.
- **Notifications**: the history, below.

Lists fade out at the bottom while more content lies below; the fade is removed
when the real end is reached, so it never implies hidden content. Every list
has an empty state.

## Tooltips

`src/Tooltip.tsx` and `src/tooltipPlacement.ts`.

Tooltips are compact (6 to 10 px padding, 12 px label, optional 11 px detail),
dark and lightly frosted, and appear after 380 ms of hover (120 ms on keyboard
focus). They fade and slide 3 px in 140 ms. A pointer press, scroll or Escape
closes them. They never replace accessible labels.

### Placement

`computePlacement()` is a pure function:

1. Measure the target and the rendered tooltip.
2. For each side (top, bottom, right, left; the caller's preference first),
   place the tooltip a gap from the target and slide it along that side to stay
   inside the viewport.
3. Score each candidate: clipped area × 1000, plus area covering the target ×
   100, plus weighted area covering neighbouring regions.
4. Choose the lowest score; ties go to the preferred order. Clamp inside the
   viewport whatever happens.

Neighbouring regions are collected at open time by `avoidRegions()`: controls
within reach (weight 10) and regions marked `data-tip-avoid` such as the
legend, notification capsule, time control, Terminate and the tutorial card
(weight 1). Covering a control costs more than covering a readout, because a
hidden button blocks an action while a hidden label only delays reading. A
region that contains the target (the rail around one of its buttons) is its
container, not a neighbour. Placement is recomputed on window resize, so it
adapts to window size and browser zoom.

Map inspection cards use the same placement around the pointer.

## Tutorial

`src/Tutorial.tsx`, `src/useTutorial.ts`, `src/tutorialSteps.ts`.

One card and one spotlight persist for the whole tour and glide between
targets (380 ms), so the tour reads as one guide rather than separate pop-ups.
The spotlight is a single element whose large shadow dims the rest of the
screen. Card placement is edge-aware (below, above, right, left, clamped) and
is re-measured every frame, so it follows layout changes.

**Lifecycle.** Starting the tour pauses simulation time only (with a playback
lease, so it never resumes a run it did not pause). The interface keeps
rendering and animating. The tour covers the map, map tools, Auto Focus, Do
Not Disturb, Settings, telemetry, Layers, time and progress, speed, seed and
new worlds, and runtime status, and ends on the playback controls:

> **You're ready.** Start the simulation when you are ready to begin.
> [Start Simulation]

**Start Simulation** closes the tour and plays the run. **Skip tour** closes it
and resumes only if the tour paused the run and nothing changed since.

Conditional elements (backpressure indicators, notifications) are never tour
targets. If a target is hidden at the current window size the card says so and
the tour can continue. With `tutorial.show_on_startup` the tour starts when a
world first loads, once per browser.

## Simulation complete

When the virtual day reaches 24:00:00 a dialog announces **Simulation
Complete** with the final time, simulated duration, observation time, incident
count, significant events, rain events, peak congestion and the seed. Counts
come from the complete news record fetched from the core, not the recent window
on screen. **Download Report** runs the report pipeline; **Close** dismisses
it. If another dialog is open when the day completes, the completion dialog
follows when it closes.

## Report

`src/report.ts` (composition), `src/reportModel.ts` (derivation, pure),
`src/pdfLayout.ts` (layout engine), `src/telemetryRecorder.ts` (session
telemetry).

### Data

| Source | Scope |
|---|---|
| News, fetched in full with `api.allNews()` | Whole run |
| Congestion history (per virtual minute) | Whole run |
| Snapshot and topology | Report time |
| Observer telemetry log | Observed session |

The telemetry recorder takes one sample per delivered snapshot: vehicles,
halting, vehicle-weighted mean speed, congestion, flooded and closed roads,
rain cells, peak intensity and footprint, incidents, throughput, snapshots per
second, backpressure score and state, round-trip latency and runtime status.
It also logs operator controls and lifecycle, backpressure and status
transitions. It is bounded (2400 samples): when full, the older half is thinned
to every second sample, so a long session keeps its whole shape. When the day
is replayed after stepping back, the latest pass supersedes the earlier one in
simulation-time charts.

### Contents

Cover and contents, then:

1. Executive Summary: tiles and key observations
2. Simulation Configuration: scenario, map, systems and layers
3. Environment and Runtime: versions, platform, observation times (no
   filesystem paths)
4. Road Network Analysis: connectivity, degree distribution, road classes,
   road state, places
5. Traffic Analysis: congestion across the day, congestion periods, vehicles,
   mean speed, most congested roads
6. Weather Analysis: rain event table, durations, activity and footprint charts
7. Flooding Analysis: onsets by hour, flooded and closed roads, rain
   correlation
8. Incident Analysis: severity and type distributions, register, descriptions
9. Simulation Event Timeline: every significant event in order
10. Performance and Telemetry: data delivered, throughput (KiB/s or MiB/s),
    snapshot rate, round trip, backpressure with intervention bands,
    interventions, degraded periods, operator controls
11. Determinism and Integrity: seed, run id, graph and scenario hashes,
    lifecycle
12. Map at Export (when the map is drawn)
13. Methodology and Definitions

Statements are labelled **Observed**, **Derived** or **Interpretation**.
Missing measures are reported as missing ("Not enough samples of throughput
were recorded"), never estimated. Every chart has a title, the question it
answers, axis titles with units, a legend where there is more than one series,
and clock-based ticks (every 3 hours for simulation time, round minutes for
observation time). The report follows the 12 or 24 hour preference. A busy day
produces about 20 to 30 pages; a short observation about 10.

### Layout guarantees

The layout engine measures every block before placing it:

- A block that would cross the bottom margin moves to the next page.
- Headings keep with at least 26 mm of following content; sections start a new
  page when less than 90 mm remains.
- Tables wrap cells within columns and repeat their header row on every page.
- Charts are placed whole.
- Page headers and footers ("Page n of N") are drawn after layout, so totals
  are exact.

Every text line is recorded with its page and rectangle. The report tests
build real PDFs and assert that no two text boxes overlap, that all text stays
inside the margins, that headers repeat, and that no em dashes or development
language appear.

## Minimum screen size

DSTNS is an operator interface for laptop and desktop displays. Below
**1024 x 640** the interface is not squeezed: it is replaced by a notice in the
same design, saying so, reporting the current and required sizes, and leaving
on its own as soon as the window is large enough. The simulation is unaffected.

Those figures come from the laid-out interface rather than a round number. At
1024 px the command rail still carries transport, the clock, all seven speeds,
the seed, the re-roll, runtime status and Terminate on one row (it drops the
seed's label and the word Terminate below 1180 px); at 640 px the map keeps
about 400 px between the header and the rail. The browser suite asserts both,
along with the absence of any overlap at that size.

## Dialogs, errors and empty states

Dialogs share one shell (`Scrim` in `src/Dialogs.tsx`): the map stays visible
behind a light blur, focus is trapped and restored, Escape dismisses, and entry
and exit are animated so nothing appears or disappears abruptly. Destructive
confirmations (Terminate) use red; others use cyan.

| Situation | Presentation |
|---|---|
| Core unreachable | Error banner; runtime status Offline; controls disabled |
| Stale data | "Simulation data is stale. Reconnecting."; Degraded |
| Map download failed at startup | Error banner with city, coordinates and cause |
| World generation failed | Overlay with reason, Retry and Return |
| Report failed | Error banner, and inside the completion dialog |
| Clipboard refused | "Copy failed" in place |
| Tutorial target hidden | Note in the tutorial card |
| No incidents, news or queue items | Empty-state rows |
| No layer data yet | "Layers apply once a map is loaded." |
| Interface suspended by backpressure | Suspension dialog with Play/Pause, Reset and Terminate |
| Window below the supported size | Full-screen notice with the current and required sizes |

## Motion

| Interaction | Duration |
|---|---|
| Hover feedback | 140 ms |
| Selection (speed, switches, segmented controls) | 200 ms |
| Panels (Layers, search, menus) | 280 ms |
| Notification expansion | 320 ms |
| Settings drawer | 320 ms |
| Tutorial movement | 380 ms |
| Camera glide | 650 ms to 1.4 s, distance-scaled |
| Applied-speed glide | 520 ms |

One ease-out curve (`cubic-bezier(0.22, 1, 0.36, 1)`) is used for arrivals.
Press feedback is a small scale-down. Nothing bounces. Reduced motion (the
operating system preference, the Settings switch, or backpressure) removes
decorative animation, makes the camera jump, and still shows the paused state
statically.

## Accessibility

- Every control is a semantic button, switch, radio or checkbox with an
  accessible name; icon-only controls are labelled.
- Visible focus rings on every control.
- The speed control is a radio group with arrow, Home and End keys; Layers
  switches move with the arrow keys.
- Dialogs trap and restore focus; Escape closes panels, menus and dialogs.
- Status is never conveyed by colour alone: runtime status has text, severity
  has labels, the legend has names.
- Tooltips add information but never replace a label.

## Architecture

| Concern | Where |
|---|---|
| Polling, snapshots, news, latency | `useSimulation.ts` |
| Configuration layers (built-in, operator file, viewer) | `uiConfig.ts` |
| Time format preference | `preferences.tsx` (`TimeFormatProvider`, `useTimeFormat`) |
| Formatting | `timeFormat.ts` |
| Notifications, taxonomy, DND | `notificationModel.ts`, `NotificationCapsule.tsx`, `focusNotification.ts` |
| Auto Focus geometry | `autoFocus.ts`; camera in `NetworkMap.tsx` |
| Tooltip placement | `tooltipPlacement.ts`, `Tooltip.tsx` |
| Session telemetry | `telemetryRecorder.ts` |
| Report | `report.ts`, `reportModel.ts`, `pdfLayout.ts` |
| Icons | `Icons.tsx` (one 24-unit box, explicit pixel sizes) |
| Styles | `system.css` (tokens and redesigned surfaces) over `hud.css`, `theme.css` and `style.css` |

Shared presentation state (`timeFormat`, Auto Focus, DND and its lists, layers,
playback intervals) lives in the configuration object held by `App` and is
persisted as differences from the operator's file. Simulation state comes only
from the core. The time format reaches components through context rather than
props. World generation state (`requestedSeed`, `status`, `error`) is local to
`App` and driven by the core's job status.

Core additions for this interface: `SimulationEngine::step()`,
`regenerate_world()`, `world_status()` and `preparation_stage()` in
`src/engine.cpp`, with routes in `src/api.cpp`. Starting a world is shared
between the CLI start path and regeneration through `install_scenario()`.

### Design system

`system.css` holds the tokens every surface takes its material from: the glass
background, border, blur and shadow; a radius scale (6 chips, 10 controls,
14 cards, 18 popovers, 24 panels, pill for free-floating controls); control
heights (26, 32, 36); icon sizes (14 inline, 16 utility, 18 primary); and
motion (120 ms hover, 170 ms selection, 220 ms popovers, 280 ms panel morph).
The command rail is the reference: every panel, menu, legend, dialog and
loading surface inherits from it rather than carrying its own values.

Menus and popovers share one placement routine with tooltips
(`computePlacement`), so a menu near the bottom rail opens upward and one near
an edge slides inward instead of being clipped. The queue's category filter is
a custom listbox, not a native `<select>`: no default browser control remains
in the interface.

### Brand mark

The wordmark in `src/assets/logo.svg` is the only source. `logoAsset.ts` crops
it to the artwork and drops its backdrop; `scripts/make-favicon.mjs` groups the
wordmark's sub-paths into glyphs and cuts the first one, the D, into
`public/favicon.svg`. Replacing the logo and re-running the script re-cuts the
icon, with no geometry duplicated anywhere.

## Performance

- The map draws on canvas; camera glides animate the view directly without
  re-rendering other components.
- Notification grouping, target derivation and DND filtering are memoized on
  their inputs; only a bounded number of notifications is rendered.
- The camera moves only when an event's framing signature changes.
- The telemetry recorder is bounded and samples once per snapshot.
- Backdrop blur is limited to floating panels; the full-screen scrims use a
  light blur only while a dialog is open.
- The report is generated on demand and loaded lazily.

## Verification

| Suite | Command | Covers |
|---|---|---|
| UI unit and integration | `npm test --prefix ui-engine` | Formatting, notification model and DND, Auto Focus geometry, tooltip placement, telemetry, configuration, report model and PDF layout, the full shell with mocked core |
| HUD in a real browser | `node ui-engine/tests/browser-hud.mjs` | Live core: layout at 2560, 1920, 1440, 1280 and 1024x640 with no overlaps, the notice below the minimum, tooltip collisions, speed and step reaching the engine, paused state, the numeric seed copied, settings and layers, notification capsule, telemetry collapse and side panel, place legend, tutorial start to finish, world regeneration, PDF download |
| End to end | `node ui-engine/tests/browser.mjs` | CLI-only start, pause and resume, speed, persisted motion, queue, real signal and place inspection, demand notification, responsive layouts, report, malformed data, completion, termination |
| Core | `ctest --test-dir build` | Includes `dstns_world_and_stepping` for step and regeneration, including failure preserving the previous world |
| HTTP | `python3 tests/api/api_smoke.py` | Step and world endpoints among the full API |

The CLI preflight runs the core, HTTP and UI suites at startup and validates
`config/ui-config.json`.
