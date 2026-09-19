# DSTNS observer modernization

The production UI uses the design reference in `ui-engine-alpha/templates/index.html` (there is no `ui-engine-alpha/index.html`). React components implement its dark navy surfaces, cyan/mint hierarchy, frosted floating panels, category controls, event sidebar and bottom playback bar. It is not an embedded prototype. Fonts are bundled locally; `/media/logo.png` is optional.

## Authority and operation

```
./launcher start --seed 382923 --day-type weekday --save-seed campus-test
./launcher start --saved-seed campus-test --day-type weekend
./launcher seeds list
./launcher seeds inspect campus-test
./launcher seeds delete campus-test
./launcher seeds save another-run --seed 42 --osm-file data/fixtures/real_network.osm.xml
```

`start` starts playback, including non-interactive invocations. It attaches to a healthy local server or builds/launches one. A newly owned non-interactive server remains in the foreground until interrupted; attaching leaves that server alive. Default day is weekday and playback duration is 3,600 seconds. `--duration` accepts integer 60–3,600; `--speed` accepts 0.01–100; `--max-nodes` accepts integer 2–50,000. Decimal seeds and `0x` hexadecimal seeds are validated as unsigned 128-bit values. Auto generation uses cryptographic entropy once, then records the resolved seed. Runtime RNG remains counter-based and domain separated.

`DSTNS_API_PORT` selects the local server port. The server writes a private `logs/operator.token`; the CLI reads it. An external operator process can set `DSTNS_OPERATOR_TOKEN`. The existing `/api/v1/playback/start` route requires `X-DSTNS-Operator`, rejects uncredentialed browser requests with HTTP 403 / `CLI_START_REQUIRED`, and preserves its normal response envelope. The UI has no credential, start, prepare, day selection, incident placement, closure, signal-editing or demand-injection client methods. It offers pause/resume and speed only. Layer toggles change rendering, not engine module state.

The core remains the authority. The UI polls revisioned snapshots/status sequentially without overlapping refreshes, caches topology per run, and renders dynamic layers independently. It disables controls for stale/unavailable state, handles idle/paused/running/completed/terminated states and reconnects automatically. The existing SSE endpoints remain supported for other clients.

## Saved configurations

SQLite at `data/seed-store/seeds.sqlite3` stores unique IDs, canonical seed, creation time, description, map algorithm version, source SHA-256 and full resolved startup payload. SQL bindings prevent name injection; IDs never become paths. Saving copies OSM bytes to a SHA-addressed map cache. Duplicate IDs fail rather than overwrite. Reuse verifies both version and source checksum. Delete removes the registry entry; shared map blobs are intentionally retained. `DSTNS_SEED_DB` selects an alternate registry (used by isolated tests).

An explicit day/map/speed override changes the effective run; exact replay requires the saved configuration without overrides. `urban-crfg-v2` is incompatible with old district-selection hashes. The seed alone cannot identify a changing upstream OSM snapshot: source bytes are part of deterministic configuration.

## Real geography

The seed chooses the place. `seed.derive("map.city")` selects one of sixteen metropolitan areas and `seed.derive("map.anchor")` selects coordinates inside it.

**One download per city, many districts.** The download unit is a *city extract*: a square of `map.city_extent_m` (5 km by default) centred on the city, cached at `data/maps/<city>_x<extent>.osm.xml`. Because that name depends only on the city, every district of that city reads the same file. The seed's anchor then picks where inside it the district grows: the road loader starts from the junction nearest the anchor and grows a connected district of `map.district_nodes` (3,000 by default). So re-rolling usually lands on a different part of an already-downloaded city and costs nothing, and only crossing to a new city triggers a download.

```
./launcher start --seed 0x4cafe     # Berlin, downloads the 5 km extract once (~60 MB)
./launcher start --seed 0x18cafe    # Berlin again, different district, no download
./launcher start --seed 0x15cafe    # San Francisco, one new extract
```

Catalog: Tokyo, London, New York, Paris, Berlin, Singapore, Sydney, Toronto, Mumbai, Seoul, Sao Paulo, Cairo, San Francisco, Amsterdam, Stockholm and Dubai. The boxes are inner-urban extents rather than administrative boundaries, pulled in off coastlines and harbours so a seeded anchor cannot land mostly on water.

The district is deliberately a fraction of the extract. `district_nodes` is the operative cap; a 60 % share of available nodes only binds when the source is itself small, where taking all of it would make every seed produce the same map. Keeping districts to ~3,000 junctions also bounds how much geometry the browser must draw.

**Cache hygiene.** City extracts are tens of megabytes, so the server sweeps the cache once at startup (`--map-cache`, default `prune`):

| Policy | Effect |
| --- | --- |
| `prune` | Keep the `--map-cache-keep` newest extracts (default 1), delete the rest |
| `clear` | Delete every cached extract |
| `keep` | Never delete; the operator manages the directory |

Interrupted `.part` downloads are discarded under every policy. Pruning means a long-lived install cannot accumulate one extract per city it has ever visited, while re-running the city you were last using stays offline.

**Failure is failure.** A download that cannot complete raises HTTP 503 `MAP_FETCH_FAILED`, naming the city, the coordinates and the cause (offline, Overpass rate limiting, or a district under 400 junctions because the area is water or unmapped). No bundled map is substituted, because quietly serving a different map would break the correspondence between a seed and the place it denotes. Partial downloads are removed rather than cached.

An explicit source still overrides the seed entirely, which is what the test suites use:

```
python3 scripts/fetch_osm.py --anchor 52.4981,13.4412 --radius-m 1200 --output data/maps/custom.osm.xml
./launcher start --osm-file data/maps/custom.osm.xml --seed 42
```

The importer queries public Overpass, retries 429/502/503/504 with backoff, validates the XML, refuses overwrites, writes source/license/query/checksum metadata, streams the response while publishing progress to a `.progress` sidecar, and writes via a temporary file then renames so an interrupted download cannot be mistaken for a complete map. `GET /api/v1/system/map-status` reports that progress, which is what the operator CLI renders as a progress bar. See [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL) and [OSM attribution](https://www.openstreetmap.org/copyright). Downloads are never performed by the browser, and never at server boot: the server compiles no scenario until a run starts, so `/api/v1/view/topology` is empty while IDLE.

## Events, signals and demand

`EventRuntime` maintains a binary min-heap ordered by `(virtual_second, sequence)`. Insert/pop are O(log n), peek O(1). Immutable spatial neighbours are shared across checkpoints, and edge-demand multipliers are recomputed only after demand events. One future transition is retained per controller, with its successor inserted when executed. Signal correctness does not depend on polling/render rate. The browser receives at most 30 event rows per page; the API enforces a maximum of 200. History retains the last 2,000 executions with an all-time execution count; it is explicitly not a complete historical archive. Paginated inspection copies the pending heap under the engine lock and costs O(n log n), separate from O(log n) simulation scheduling.

Each junction has stable seed/OSM-ID-derived offset and timing. Two geometric approach groups (north/south and east/west) alternate green, 3-second amber, 1-second all-red, other green, amber, all-red. Cycles are bounded to 50–120 seconds. The modeled cycle uses degree, incoming capacity and deterministic variation; green allocation follows relative incoming capacity with minimum 12 seconds per group. These are modeled capacity proxies, not measured turning-demand estimates. Plans are static during a run, independently phased, and exactly sum to their cycle lengths.

Significant actual POIs have seeded scheduled multiplier changes: school arrival/departure and office commutes on weekdays, retail/commercial peaks, hospital baseline demand. A 400-metre Wendland spatial kernel maps these effects to nearby edges. Neighbours are indexed once in spatial cells. Scheduled events change modeled edge demand and expose causal POI IDs, not just visual alerts. Active POI icons turn red; important changes produce bounded toasts and activity entries. Traffic-signal transitions never produce toasts.

Physics uses fixed one-second virtual steps. Playback speed changes wall-clock pacing only. Fractional modeled vehicle load is preserved between steps, avoiding loss of sub-vehicle inflow through integer rounding. Checkpoints include signal state, demand multipliers, heap, recent history and congestion tracker. Rewind restores these before deterministic forward replay.

Flood thresholds produce event-history observations. Incident and weather schedules also appear in future/history views; weather field calculations and active incident composition retain the existing core implementation. Congestion does not manufacture an incident ID or fictional expiry.

## Traffic signals

Controllers belong at intersections, and OpenStreetMap does not put them there.
It tags `highway=traffic_signals` on the **stop-line node of one approach**, a
few metres back from the junction, which in this graph has degree 2. Taking the
tag literally scattered controllers along straight roads; requiring a real
junction degree deleted every one of them. In a Berlin district all 49 tagged
nodes had degree 2.

So each tagged node is snapped to the nearest junction (degree >= 3) within 45
metres, and several approaches to one junction collapse onto the single
controller that governs it. That district's 49 stop lines become 30 controllers,
all at degree 3-5 junctions, none mid-block.

Phasing was already an ordered two-group alternation — opposing approaches share
a green, then amber, then all-red, then the cross street. What looked random was
the **offset**: each controller drew its own at random, so neighbours changed
independently. Offsets now follow travel time from the network's centre at a
nominal 50 km/h, wrapped into the cycle, which is how a real corridor is timed:
a platoon released at one junction arrives at the next on green. Adjacent
signals therefore turn over in sequence rather than flickering.

## Congestion and state semantics

For traversable directed edges, using DSTNS aggregate model outputs:

```
C_edge = closed ? 1 : clamp(0.60 × speed_loss + 0.25 × queue_ratio + 0.15 × occupancy, 0, 1)
speed_loss = vehicles > 0 ? clamp(1 - mean_speed/free_speed, 0, 1) : 0
queue_ratio = halted_vehicles / max(1, vehicles)
w_edge = length_metres × lanes
C_network = 100 × sum(w_edge × C_edge) / sum(w_edge)
alpha = 1 - exp(-dt_virtual / 900)
Average = alpha × Current + (1-alpha) × previous_Average
```

The first observation initializes the EMA. Both values stay within 0–100%; history is sampled each virtual minute, independent of UI refresh. The UI labels the difference in percentage points (`pp`). Synthetic reverse edges never contribute weight. Zero traffic yields zero congestion except genuinely closed infrastructure.

Primary color precedence: known flood (`flood > 0.01`, blue), blocked/severe incident or congestion (`C >= 0.70`, red), moderate (`C >= 0.35`, amber), clear (green). Tooltips expose simultaneous flood, rain, incident, signal and POI-demand effects. Rain existence alone never colors a road red. Weather regions show actual radius/intensity separately.

## Licence

DSTNS is licensed under the **GNU Affero General Public License v3 or later**, copyright (C) 2026 Varun Karthic. The full text is in `LICENSE`; `COPYRIGHT` carries the notice and the third-party data terms.

Because the program is normally operated over a network, AGPL section 13 applies: anyone interacting with a modified version remotely must be offered the corresponding source of that version. Two things implement that offer — `GET /api/v1/system/source` returns the program, version, licence and source offer as JSON, and the observer header links to it. The operator CLI prints the notice at every start and answers `--version` and `--license`; the server answers `--version`.

Map data retrieved from Overpass is © OpenStreetMap contributors under ODbL 1.0, which is separate from and not superseded by this program's licence. Downloaded extracts under `data/maps/` are therefore data, not source, and each carries a `.manifest.json` recording its origin and checksum.

## Observer shell

The layout follows `ui-engine-alpha/templates/index.html`: a fixed header, a
full-bleed map, a floating control dock at top-left, a coordinate and scale HUD
above the controls, a glass telemetry deck on the right, and a two-tier playback
controller along the bottom. The mockup's tokens are transcribed into
`src/theme.css` as custom properties, so the app keeps its plain-CSS build and
gains no utility-CSS dependency.

**Structure.** The bottom chrome — HUD row, control strip and playback dock — is
one bottom-anchored flex column, so their spacing is structural rather than a
stack of hand-tuned offsets that drift apart. Stacking order is named once in
`--z-*` variables; Display Layers sits above notifications deliberately, so a
burst of events can never bury the control being used.

**Components.** `MapDock` (zoom, fit, search, auto-focus, do-not-disturb,
reduced motion), `TelemetryDeck` (metrics, congestion, and Stack/News/Queue/
Incidents tabs), `PlaybackDock` (scrubber, clock, rate, transport), `Dialogs`
(About, confirmations, the auto-focus offer, the ASB suspension overlay),
`Splash`, `Logo`, and `NetworkMap`, which exposes an imperative `MapControls`
handle plus `onView`/`onCursor` callbacks.

**Search** is an icon in the dock that expands beside it, rather than a bar
occupying the top of the map: the map keeps its full width until someone
actually wants to look something up.

**Motion.** Two named curves carry the whole interface: `--ease-out` for things
arriving and `--spring` for things responding to a press. Controls scale down
slightly when pressed, the play button lifts and glows on hover, the reset glyph
rotates, and every dialog has a paired entry and exit transition so nothing
appears or vanishes abruptly. Modals blur the map behind rather than hiding it.
All of it is disabled under reduced motion.

**The rate slider** is indexed, not linear. The handle sits at the index of the
value and the tick labels are drawn from the same array at the same offsets, so
the label under the handle is always the value the handle sets. When ASB pulls
the rate down the handle *eases* to its new mark over several frames, so a
governed change reads as deceleration rather than a jump.

**What reaches the core, and what does not.** Playback — play, pause, step,
reset and the rate — calls the core. Everything about presentation stays local:
display layers, place names, clock format, reduced motion, do-not-disturb,
auto-focus, the seed toggle, pan and zoom. `tests/appShell.test.tsx` asserts
this directly by recording every non-GET request and requiring the list to be
empty after a layer is toggled and after do-not-disturb is engaged.

**Destructive actions confirm.** Reset and Terminate open a dialog first; the
click alone never reaches the core, which the tests assert.

**Places.** A feature's `category` is the raw OSM tag value — whatever a mapper
typed. `placeKind()` normalises it to a short kind and a glyph, so an unnamed
building reads as **School**, not "Unnamed kindergarten". Roads do the same
through `roadTitle()`: a nameless service road is a "Service road".

## Splash and boot

The interface starts before the core has a map — a district is often being
downloaded, which takes tens of seconds. Rather than an empty page, the splash
assembles the mark and reports the stage the core is actually in, read from
`/api/v1/system/map-status`: contacting Overpass, downloading with a byte count
and a real percentage when Content-Length is known, validating, compiling. It
sweeps rather than inventing a percentage when the total is unknown. After
twelve seconds it offers a way past, so a stalled download never traps anyone.

## Accessibility and reporting

Reduce Motion starts from `prefers-reduced-motion`, supports an explicit persistent override, hides all vehicle-flow markers and disables nonessential animation/transitions. Roads, static POI alerts, incidents, weather and signal state remain visible. Delayed custom tooltips are shared across map entities and controls. Controls support focus/keyboard interaction; map pan/zoom is keyboard operable and place search provides keyboard inspection. No browser `title` tooltips are used.

Export Report downloads a four-page PDF generated locally from observed state, on one grid and one type scale across all four pages: **Run and provenance** (seed, lifecycle, graph hash, and which real city the seed resolved to, with its coordinates and whether the extract was downloaded or cached), **Congestion** (current, moving average, delta, the day's curve, the road-state mix, and the most congested roads that are actually carrying traffic — closures score 1.0 with nothing on them and are counted separately), **Geographic network** (the map as rendered, road classes by length, and places by kind), and **Events and runtime** (weather, flooding, incidents, demand, the ASB state and throughput, and recent events). The DSTNS mark is drawn as vectors, so the report needs no image asset and cannot fail on a missing one. It shares the dark palette, typography hierarchy, panels and semantic colors. An embedded local Inter font makes export independent of font services and retains Latin diacritics; optional logo failure does not block export. Current map viewport and layer visibility are preserved.

## Startup verification

`./launcher` verifies the install before it starts anything. Twelve checks, in
increasing cost, each reporting what it found rather than only pass or fail:
host platform, Node, Python 3, the licence, both configuration files parsing,
the map fetcher compiling, the map cache being writable, the core binary and its
version, whether the observer bundle is older than its sources, the API port,
and **both test suites**.

Running the suites at startup is deliberate: it makes "the system is good to go"
a statement about this machine rather than about CI. They are the fast ones —
roughly 3 s for the core and 8 s for the observer.

A `fail` stops startup and names what failed; a `warn` continues and says what
is reduced (a stale bundle, for instance, is rebuilt on start). The same checks
are available programmatically from `dstns-operator-cli/preflight.mjs`.

## Transit migration and model boundaries

`POST /api/v1/control/transit/route` is retired and returns HTTP 410 with `TRANSIT_API_RETIRED`; it is not a supported public API. UI dispatch, route-record storage and dead client types were removed. The canonical route planner and internal bus-stop/trip support remain useful and are retained.

The live engine is an aggregate traffic model. SUMO is a separate export/batch validation adapter, not an in-process telemetry feed. Map vehicle dots are representative flow samples based on actual modeled edge count/speed, not individually tracked vehicle positions. Individual vehicle IDs/trajectories and lane-level signal conflict geometry require a future live SUMO adapter and canonical vehicle/movement mapping; they cannot be honestly inferred from the present state.

OSM multipolygon relation assembly and inner-ring holes are not implemented by the existing lightweight loader; complete simple ways and point features are retained. A future relation-aware importer should assemble rings with source-ID provenance before district selection. Complex buildings may therefore have incomplete footprints, which is preferable to inventing geometry.

Legacy operator world mutations (day/module/manual weather/road/signal overrides) retain their existing API, but their undo/redo journal is not a fully time-indexed replay journal. Exact deterministic replay is verified for fixed startup configuration, scheduled engine events and playback controls. Replaying arbitrary historical operator edits requires a future command-event journal included in checkpoints; the observer exposes none of those world-mutation controls.
