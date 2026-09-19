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

The layout follows `ui-engine-alpha/templates/index.html`: a fixed header, a full-bleed map, a floating control dock at top-left, a coordinate and scale HUD at bottom-left, a glass telemetry deck on the right, and a two-tier playback controller along the bottom. The mockup expressed its tokens through a Tailwind CDN config; they are transcribed into `src/theme.css` as custom properties, so the app keeps its existing plain-CSS build and gains no utility-CSS dependency. The three mockup typefaces (Inter, Space Grotesk, JetBrains Mono) were already vendored through `@fontsource`.

Components: `TelemetryDeck` (metric tiles, congestion meter, and Stack/News/Queue/Incidents tabs), `PlaybackDock` (scrubber, clock with 12/24-hour toggle, rate slider, transport controls), `LayersPopover` (display layers), and `NetworkMap`, which now exposes an imperative `MapControls` handle so the zoom and fit buttons can live in the dock, plus `onView`/`onCursor` callbacks that feed the HUD.

**What reaches the core, and what does not.** The playback controls are genuinely remote: play, pause, step, reset and the rate slider call `/api/v1/playback/*` and `/api/v1/control/tick-rate`. Everything about presentation stays local. Display layers, the 12/24-hour clock format, reduced motion, the seed expansion toggle, map pan/zoom and the legend are frontend state only; toggling a layer changes what is drawn and never what is computed. `tests/appShell.test.tsx` asserts this directly by recording every non-GET request and requiring the list to be empty after a layer is toggled.

The header names the seed-selected district (`Berlin, Germany`) and the HUD reports live coordinates under the cursor, falling back to the tile anchor, then the projection origin. A run started from an explicit `--osm-file` has no seed-derived location; the core still emits the block with empty strings, and the UI treats that as absent rather than displaying 0.0000 N, 0.0000 E. A `MAP_FETCH_FAILED` response is surfaced as its own alert style rather than a generic connection error.

## Accessibility and reporting

Reduce Motion starts from `prefers-reduced-motion`, supports an explicit persistent override, hides all vehicle-flow markers and disables nonessential animation/transitions. Roads, static POI alerts, incidents, weather and signal state remain visible. Delayed custom tooltips are shared across map entities and controls. Controls support focus/keyboard interaction; map pan/zoom is keyboard operable and place search provides keyboard inspection. No browser `title` tooltips are used.

Export Report downloads a three-page PDF generated locally from observed state: configuration/congestion history, current geographic map, and event/effect summary. It shares the dark palette, typography hierarchy, panels and semantic colors. An embedded local Inter font makes export independent of font services and retains Latin diacritics; optional logo failure does not block export. Current map viewport and layer visibility are preserved.

## Transit migration and model boundaries

`POST /api/v1/control/transit/route` is retired and returns HTTP 410 with `TRANSIT_API_RETIRED`; it is not a supported public API. UI dispatch, route-record storage and dead client types were removed. The canonical route planner and internal bus-stop/trip support remain useful and are retained.

The live engine is an aggregate traffic model. SUMO is a separate export/batch validation adapter, not an in-process telemetry feed. Map vehicle dots are representative flow samples based on actual modeled edge count/speed, not individually tracked vehicle positions. Individual vehicle IDs/trajectories and lane-level signal conflict geometry require a future live SUMO adapter and canonical vehicle/movement mapping; they cannot be honestly inferred from the present state.

OSM multipolygon relation assembly and inner-ring holes are not implemented by the existing lightweight loader; complete simple ways and point features are retained. A future relation-aware importer should assemble rings with source-ID provenance before district selection. Complex buildings may therefore have incomplete footprints, which is preferable to inventing geometry.

Legacy operator world mutations (day/module/manual weather/road/signal overrides) retain their existing API, but their undo/redo journal is not a fully time-indexed replay journal. Exact deterministic replay is verified for fixed startup configuration, scheduled engine events and playback controls. Replaying arbitrary historical operator edits requires a future command-event journal included in checkpoints; the observer exposes none of those world-mutation controls.
