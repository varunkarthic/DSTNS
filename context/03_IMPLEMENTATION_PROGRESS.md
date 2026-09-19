> Current implementation and measured gates: [modernization validation](modernization_validation.md). The original phase checklist below is historical; earlier MapLibre/Caddy/live-microscopic claims are not descriptions of the current runtime.

# Implementation Progress (03)

- [x] Phase 0: Legacy audit and design specification review.
- [x] Phase 1: Core math, Seed128, Philox RNG hierarchy, SHA-256 digests.
- [x] Phase 2: OSM loader, road filtering, CRFG frontier growth, DRNCP canonicalization.
- [x] Phase 3: Bus stops, synthetic buildings ($T_{\text{max}}$ profiles), Webster signals.
- [x] Phase 4: Macroscopic traffic demand, recurrent hotspots, deterministic A* routing.
- [x] Phase 5: SUMO plain-XML export, netconvert validation, ISumoAdapter interface.
- [x] Phase 6: DWS weather storms, Wendland kernels, flood reservoirs, weather/traffic coupling.
- [x] Phase 7: Event precompilation, playback engine, three-clock model, checkpoints, undo/redo.
- [x] Phase 8: REST APIs (Playback, View, Control, News, System), SSE streaming, OpenAPI 3.1.
- [x] Phase 9: SQLite WAL logging, system.log, interactive CLI launcher (`launcher.py`).
- [x] Phase 10: UI Engine (React 19, MapLibre GL JS, Fastify UI Overlay API).
- [x] Phase 11: Docker Compose, Caddy TLS gateway, containerization.
- [x] Phase 12: Dedicated CLI tools (`road_index`, `replay_verify`, `benchmark`), test suites, comprehensive documentation.

## 2026-09-12 observer modernization — initial analysis

Reference: `ui-engine-alpha/templates/index.html` (the requested root index.html is absent). Inspected core/model/graph/compiler/OSM/RNG, engine lifecycle/physics/checkpoints/serialization, API routes, launcher/operator CLI, UI/map/styles/types/transport, SUMO bridge, logging, tests/configuration and architecture documentation.

Initial findings: compiler produces canonical topology -> GraphStore -> engine fixed-step aggregate traffic/DWS model -> revisioned HTTP/SSE API -> React canvas. SUMO is a separate export/batch validation bridge, not the live telemetry authority. Existing comments that claim microscopic live traffic are inaccurate. Before modernization, the browser created runs and manual effects; Transit route dispatch is UI-only with an engine record and has no necessary core dependency.

Plan: retain this architecture; richer real OSM geography and versioned district selection; heap-scheduled independent signal/demand state with checkpoint restoration; authoritative congestion EMA; CLI startup and SQLite saved configurations; observer canvas/components using alpha tokens; bounded event pages and report export; regression/runtime/browser/PDF gates. No fake geographic fallback in normal CLI operation. Preserve existing modified data/sumo_run outputs, frontend lockfile changes and alpha source.

Design choices: local metric projection shared by roads/footprints; static geometry cached separately from dynamic layers. Signals use two approach groups with amber/all-red safety phases (an aggregate approximation, not lane-level conflict geometry). Congestion uses measured model speed loss/queue/occupancy with length x lanes weighting, excludes synthetic reverse edges; EMA uses virtual time.

## 2026-09-12 implemented result and verification

Implemented the alpha-derived React observer, richer versioned OSM districts, independent min-heap signal/demand runtime, spatial demand caching, virtual-time weighted congestion/EMA and replay checkpoints. Added private CLI startup, weekday defaults, transactional saved seed configurations with pinned source bytes, bounded event observation, hover inspection/reduced motion and a matching locally generated PDF. Retired Transit dispatch/dead browser mutations and corrected fabricated snapshot incidents. Native JSON compression was fixed after large-map transfer measurement exposed the HTTP library's exact media-type requirement.

Release CTest 5/5, ASan/UBSan 5/5, API 83 assertions, CLI 5 tests, UI 11 tests/build, replay verification, SUMO batch smoke and actual Chrome controls/events/report/failure recovery passed. Real Berlin selection: 5,409 nodes, 12,479 features, 156 signals; saved reuse identical and adjacent-seed road-node Jaccard 0.0. Chrome sampled ~60 Hz rendering and 1.9–2.5-second initial connection. Docker/isolated Compose reached healthy and supported CLI weekend/saved startup. See the linked checklist for command evidence, full requirement mapping, container browser result and honest model/import/replay boundaries.

User-owned alpha source and pre-existing generated SUMO outputs were not reset or staged. All tests used isolated runtime logs/ports, saved-seed stores and SUMO directories. No PR/merge/public deployment or remote CI result is implied.

## 2026-09-19 on-demand city map sourcing

Pulled `origin/dstns` (`5f75fa5` "Bug Fixes") onto the local modernization tree. Nine files conflicted; resolutions: Dockerfile took the union of both layer sets, `launcher.py` took upstream's import-probe dependency check plus the local `os.chdir(ROOT)`, `src/scenario.cpp` took upstream's multi-path map lookup (since replaced), `src/engine.cpp` and `ui-engine/src/{App,NetworkMap}.tsx` kept the local observer architecture, and both READMEs kept upstream's prose with the local non-interactive launcher section appended. Upstream's `ui-engine/src/mapProjection.ts` (cos-latitude equirectangular fit) merged cleanly and is retained as the UI projection.

Replaced single-bundled-map sourcing with seed-derived, on-demand OSM tiles.

- `include/dstns/geo.hpp` / `src/geo.cpp`: a 16-city catalog of inner-urban boxes, plus `select_map_location(seed, radius)`. `seed.derive("map.city")` picks the metropolis and `seed.derive("map.anchor")` picks the coordinates, so one seed always denotes one district and a re-roll denotes a different one. Anchors range over the whole urban box; the tile may extend past it, because insetting by the tile radius collapsed the compact boxes (Sydney, Stockholm, Mumbai) to a single point and made every seed for those cities pick the same district.
- `include/dstns/osm_fetch.hpp` / `src/osm_fetch.cpp`: `acquire_map_tile` resolves a tile to a local file, keyed by `MapLocation::cache_key()`. A cache hit performs no network I/O; a miss shells out to `scripts/fetch_osm.py`. Failure raises `MapFetchError` and removes any partial file. There is deliberately no fallback to a bundled map: substituting a different map would silently break the seed-to-map correspondence.
- `scripts/fetch_osm.py`: added `--anchor lat,lon --radius-m`, retry with backoff on Overpass 429/502/503/504, explicit diagnostics for empty/remark/unparseable responses, and atomic write-then-rename so an interrupted download cannot be cached as a valid map. Area cap raised to 0.05 sq deg.
- `src/scenario.cpp`: `osm_file: "auto"` now resolves through the seed rather than a filesystem search, and records city/country/anchor/radius on the `Scenario`. A district under `kMinimumDistrictNodes` (400) raises `MapFetchError` naming the coordinates, rather than running a degenerate scenario that looks like a working one.
- `src/api.cpp`: `MapFetchError` maps to HTTP 503 `MAP_FETCH_FAILED` — environmental and retryable, not a bad request or a crash. `map.tile_radius_m` and `map.cache_dir` are configurable and validated.
- `src/engine.cpp`: `/api/v1/view/topology` gained a `location` block (city, country, anchor, tile radius, whether this run downloaded it).

Scale: node positions and edge `length_m` are true metres from the projection origin. `tests/unit/map_sourcing_tests.cpp` checks them against haversine ground truth — worst node-pair error 0.13%, edge-length error 0%. Any compression is the client's business; the backend is unaffected.

Measured: Berlin `0x4cafe` → 4,872 nodes / 10,150 edges / 8,058 features from a 38 MB tile in ~50 s. Mumbai `0x5089…` → 2,368 nodes / 5,316 edges. Coastal boxes (Tokyo, Sydney, Toronto, Mumbai, Stockholm, Dubai) were tightened after an early Mumbai anchor landed over Mahalaxmi Bay and yielded 238 nodes.

CTest 6/6 (the new `dstns_map_sourcing` suite included). Unit tests exercise cache reuse and download failure offline via `DSTNS_PYTHON=/usr/bin/false`, so the suite still runs without network.

## 2026-09-19 alpha observer shell

Rebuilt the UI to `ui-engine-alpha/templates/index.html`.

npm cannot install through this environment's TLS interception (registry reads succeed, tarball fetches fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`), so Tailwind could not be added. `strict-ssl` was deliberately left alone rather than weakened. The mockup's tokens are instead transcribed into `ui-engine/src/theme.css` as CSS custom properties — no new dependency, consistent with the existing plain-CSS codebase, and the three mockup typefaces were already vendored via `@fontsource`.

- New: `theme.css` (design tokens and component styles), `TelemetryDeck.tsx`, `PlaybackDock.tsx`, `LayersPopover.tsx`.
- `NetworkMap.tsx` gained a `MapControls` imperative handle (`zoomIn`/`zoomOut`/`fit`) so the controls could move into the alpha's floating dock, plus `onView` and `onCursor` callbacks feeding the coordinate HUD and scale bar. Its in-canvas tool cluster and scale readout were removed as duplicates.
- `mapProjection.ts` gained `metresToGeographic`, `formatCoordinate` and `scaleBarFor`, so the HUD and scale bar invert the canvas transform through the core's own projection rather than inventing factors.
- `api.ts` gained `seek`, `reset` and `terminate`.
- `EventPanel.tsx` was removed, but not its capability: the scheduled-event queue (future/history with category filter, `/api/v1/view/event-queue`) is now the deck's Queue tab, so nothing was lost in the redesign.

Control boundary: playback (play/pause/step/reset/rate) is remote; display layers, clock format, reduced motion, seed expansion, pan/zoom and the legend are frontend-only. `tests/appShell.test.tsx` records every non-GET request and asserts the list is empty after toggling a layer.

Operator CLI: `dstns.mjs` pinned `data/maps/berlin-urban.osm.xml` through `preferred_sources`, which silently bypassed the on-demand path — a seeded start was still loading the legacy bundled map. It now sends `osm_file: "auto"` by default, passes `tile_radius_m`/`cache_dir`, and logs the resolved district and whether it was downloaded or cached. `--osm-file` still pins a file, which is what the test suites use.

Layout corrections found by screenshotting real runs, not by inspection. Every one of these was invisible in the code and obvious in a screenshot:

- The coordinate HUD, scale bar, legend and attribution were hidden behind the playback dock or colliding with the place search. The HUD now sits above the control strip, the legend top-right of the map region, the search centred on the map region rather than the viewport, and attribution bottom-right.
- At 1280px the telemetry deck clipped its own metric tags against the tile edge; the tags now wrap onto their own line and the deck type scales down.
- The fit transform centred the network on the viewport, so a third of the map sat under the deck. `mapFitLayout()` in `mapProjection.ts` now returns the available width and the centre of the *visible* map area, mirroring the `--deck-width` breakpoints. It is unit tested, and `browser.mjs`/`large-browser.mjs` mirror that one small function so their synthetic pointer aiming stays in step — this arithmetic had already drifted twice.

Tests: replaced upstream's `mapFocus.test.tsx` (written against the pre-refactor App, which had Re-roll/Focus buttons the observer architecture does not have) with `appShell.test.tsx`. Added `matchMedia`, `ResizeObserver` and canvas stubs to `tests/setup.ts` for jsdom. Updated `browser.mjs`, `large-browser.mjs` and `container-browser.mjs` for the new selectors (rate is a slider, not a combobox; motion is an aria-pressed icon button; the event queue is a deck tab). Removed the `title` attributes added during the redesign, since the suite enforces custom tooltips only.

`api_smoke.py` asserted a populated topology while IDLE, which held only because upstream's engine constructor auto-compiled a default scenario. That was dropped during conflict resolution and must stay dropped: auto-compiling at boot would trigger an OSM download on server startup. The test now asserts the correct contract — empty topology while IDLE, populated with metre projection and a `location` block after start.

### Verification, 2026-09-19

All run locally against real servers and real Chrome.

| Suite | Result |
| --- | --- |
| CTest (6 suites) | 6/6 |
| UI unit (vitest) | 32/32 |
| API smoke | 89 assertions |
| CLI seeds / artifacts / launcher | 5 + 1 + 1 |
| Browser (live Chrome) | passed |
| Large-map probe | passed |
| Docker Compose browser | **not run** — daemon not running here |

Large-map probe on the seed-derived San Francisco district (5,881 nodes / 12,870 edges): 1,988 ms to interactive, frame median 16.7 ms and p95 16.7 ms (steady ~60 FPS), motion toggle 71 ms, road hover resolved "Fern Street" with demand from Saint Francis Memorial Hospital, zero page errors.

End-to-end seed behaviour through the live server and CLI: `0x4cafe` -> Berlin 52.5011, 13.4421, downloaded in ~35 s, 4,872 nodes; the same seed again -> "(cached)" in ~3 s with an identical graph; `0x15cafe` -> San Francisco 37.7915, -122.4035, fresh download in ~20 s, 5,881 nodes.

Not verified here: the Compose container path (Docker daemon down). The Dockerfile now copies `scripts/` into the image and creates `/app/data/maps`, without which a seeded start inside the container would fail with `MAP_FETCH_FAILED`; that change is unexercised.

## 2026-09-19 v2: backpressure, configuration, signals, licence

Worked through `TODO` (20 items) on branch `dstns-v2`.

### Adaptive Simulation Backpressure (items 11, 16, 20)

New subsystem: `include/dstns/asb.hpp`, `src/asb.cpp`, `tests/unit/asb_tests.cpp`, `ui-engine/src/useBackpressure.ts`, documented in full at `docs/asb.md`.

The observer reports three symptoms it alone can see — how stale its rendered snapshot is, how long its own frames are taking, and how long since it managed to poll. The core scores the worst of them in [0,1] and governs itself. Ladder: Normal (proportional throttle, then one forced default state) → Restricted (rate pinned at 1×, reduced motion forced, minimum 5 s hold) → Async (GUI suspended; simulation keeps running and streaming; only play/pause, reset and terminate remain). Recovery requires a *sustained* healthy spell at every rung, so a marginal machine cannot oscillate.

Two design points worth recording:

- **The operator's request is never discarded.** `requested_tick_rate_` is remembered while `tick_rate_` is governed, so the multiplier returns on its own when synchronization recovers instead of having to be re-entered. The API reports both.
- **The rate ceiling starts at infinity, not 1.** The first implementation initialised it to 1.0, which silently capped a perfectly healthy system to real time; the test `reset restores full operator control` caught it. `rate_capped`/`rate_cap` now say whether a ceiling exists at all, and JSON carries `-1` for "none" since it has no infinity.

Time is injected throughout, so the 14 test groups exercise every window exactly rather than by sleeping.

### Map sourcing (items 1, 8)

One **city extract** per city (5 km square, `map.city_extent_m`), cached as `<city>_x<extent>.osm.xml` and shared by every district of that city. The seed's anchor picks where inside it the district grows — the loader starts from the junction nearest the anchor. Re-rolling therefore usually moves to a different part of an already-downloaded city at no cost; only crossing to a new city downloads. Verified: four Berlin seeds → four different districts, one 60 MB download.

The cache is swept at startup (`--map-cache prune|clear|keep`, default prune keeping the newest). Interrupted `.part` files are always discarded.

### Traffic signals (item 9)

OSM tags `highway=traffic_signals` on the **stop-line node of one approach**, not the junction: all 49 tagged nodes in a Berlin district had degree 2. Taking the tag literally scatters controllers mid-block; requiring degree ≥ 3 deleted all of them. Tagged nodes are now snapped to the nearest junction within 45 m and multiple approaches collapse onto one controller — 49 stop lines → 30 controllers, all at degree 3–5 junctions. Offsets follow travel time from the network centre instead of being random, so a corridor turns green in sequence.

### Demand (item 6)

Windows were identical per building type, so every school ramped at 07:45 together, in three hard steps. Each feature now gets a deterministic ±20 min offset and a 0.8–1.2× stretch from its own identity, and the multiplier follows a raised cosine in eight steps. Measured: active places climb 14 → 37 → 60 → 99 → 149 → 170 across the morning and fall away again. `demandColor()` maps the multiplier onto white → amber → red, so the visible progression falls out of the model rather than being animated separately.

`placeKind()`/`placeTitle()` normalise the raw OSM tag (`company`, `retail`, `kindergarten`) into a kind and a glyph — an unnamed building reads as **School**, never "Unnamed kindergarten". `roadTitle()` does the same for roads.

### Configuration (item 3)

`config/ui-config.json`, served at `/api/v1/system/ui-config`, resolved over built-in defaults and under this viewer's choices. Documented at `docs/ui-configuration.md`.

**Viewer overrides are stored as deltas.** The first implementation stored a full snapshot, which silently pinned every field — a test asserting that an operator's edit still reaches a viewer who had changed something unrelated caught it. `diffConfig()` now records only what differs, and returning to defaults clears the entry.

### Observer shell (items 1, 2, 5, 6, 7, 12, 13, 15, 17, 18)

Modern tooltips with measured placement and a caret; place names separated from the buildings layer; compact bottom dock with spring micro-interactions; Display Layers above notifications by explicit z-order; About as a card; reset with a rewind glyph and a confirmation; do-not-disturb; blurred animated dialogs; search as a dock icon; auto-focus modes and a double-click strategy menu.

Layout bugs found by screenshotting real runs, not by reading code: `position: relative` in a later rule silently took the map dock out of its corner and let it fill the map; NetworkMap still rendered its own search box after the dock took over; and its canvas `aria-label` still advertised a search it no longer had.

### Report (items 4, 14)

Rewritten on one grid and one type scale over four pages, with the mark drawn as **vectors** — the previous version fetched `/media/logo.png`, which 404s. Adds map provenance, road-class and place breakdowns, the ASB state and throughput, and ranks "most congested" among roads actually carrying traffic, because a closed road scores 1.0 with nothing on it.

### Startup verification (meta)

`dstns-operator-cli/preflight.mjs`: 12 checks including **both test suites**, ~12 s total. A failure stops startup and names the cause. Two bugs in the checker itself surfaced immediately: `--reporter=basic` is not a valid vitest reporter here, and ctest omits the "N failed" clause when nothing fails.

### Deprecations

Transit dispatch was already retired (410); the UI's "Public Bus Fleet" layer is gone, and dead layer toggles that the renderer never honoured were either wired up or removed. Docker is marked deprecated in `Dockerfile`, `docker-compose.yml` and `docs/DOCKER.md`, with the reasons stated: runtime map downloads need network access, a writable cache and the Python fetcher, none of which the image made obvious.

### Licence (item 10)

AGPL-3.0-or-later, © 2026 Varun Karthic. `LICENSE` (canonical FSF text) and `COPYRIGHT`. AGPL §13 is served by `/api/v1/system/source` and a header link; the CLI prints the notice at every start and answers `--version`/`--license`; the server answers `--version`. Versions aligned at 2.0.0.

### Verification

| Suite | Result |
| --- | --- |
| CTest | 7/7 (adds `dstns_asb`) |
| vitest | 60/60 (adds `uiConfig`, extends `appShell`) |
| API smoke | 89 assertions |
| CLI suites | 5 + 1 + 1 |
| Browser (live Chrome) | passed |
| Startup preflight | 12/12 |
| Docker Compose browser | **not run** — daemon unavailable |
