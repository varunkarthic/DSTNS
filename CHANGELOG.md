# Changelog

All notable changes to DSTNS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
DSTNS uses version numbers that identify three independently versioned parts:
the engine (`DSTNS_VERSION`, set in `CMakeLists.txt`), the observer (`VERSION` in
`ui-engine/src/App.tsx`) and the HTTP API contract (`/api/v1`). Changes that
alter simulation results for an existing seed or map are called out explicitly,
because the [reproducibility guarantee](https://dstns.readthedocs.io/concepts/reproducibility/) holds
only within one version.

## [Unreleased]

**Observer 3.0.0, API contract 1.2.** The engine stays at 2.1.0, and every existing endpoint
behaves as before, 155 recorded calls being replayed to prove it, with one deliberate widening:
`tick_rate` now accepts up to 10. Results for a seed do not depend on the rate. `api_version` in
responses reads `1.2`. The observer's folder is renamed from `ui-engine/` to `WebKit/`.

### Scrolling

- **Fixed: lists did not scroll with the pointer on text.** A rule applied to every element told clipped text, which is a scroll container too, not to pass a scroll on. Over a row's title, tag or details the list did not move at all; only its icon and padding scrolled. The rule now applies only to regions that really scroll.
- **The bounce runs off the main thread.** Its whole curve is worked out once and played by the compositor, frame and all, so it stays smooth while the page is busy. It starts just before the limit, so the content no longer stops and waits for it.
- **Fixed: a second bounce after a stall.** Wheel events held up behind a busy page read as a new gesture. They are now timed by when the input happened.
- **The map keeps moving** while something scrolls and while a dialog is open. It used to pause, which there was no longer any need for.
- **Map zoom and pan drop far fewer frames.** The canvas font was set once per place, and each change to a page-wide `:has()` rule restyled the whole interface. Style work during a zoom falls from about 1,400 ms to about 30 ms.
- Removed work nothing used: the scroll fade, whose masks had already gone, measured every list on every scroll and watched every row.

### Map downloads

- **A silent download now fails.** With no new data for 200 seconds (`DSTNS_MAP_STALL_S`), the download stops and says so. It could previously wait about half an hour across mirrors and retries.
- **Mirrors that answer.** `overpass.kumi.systems` was an old name for `overpass.private.coffee`, and `overpass.osm.jp` no longer accepts connections. They are replaced by `maps.mail.ru` and `overpass.openstreetmap.fr`.
- **Faster downloads.** Responses are compressed in transit. A busy mirror is left for the next at once, and a silent one after 10 seconds without a connection or 60 without data, and an error from one mirror no longer ends the attempt. Maps are written and checked as they arrive rather than held in memory.
- **Try another city.** A failed world, at start-up or when regenerating, offers a button that tries a different city. `POST /api/v1/world/regenerate` now also accepts a request after a failed first start. With an observer open, the launcher keeps the server running for this.
- Regenerating a world uses the same screen as starting up: what is happening on the left, its details on the right.

### Finding things, and reading them

- **A place chosen from search is marked on the map:** it flashes three times and stays lit until the map is next touched.
- **Hovering an incident shows its details,** ahead of anything under it, and works whichever of the two incident layers is on.
- **Rows that are cut off open.** Click a row in Stack, News, Queue or Incidents to read all of it.
- **Show important on top,** a new setting that is on by default (`notifications.important_first`). The capsule shows the most important event and counts the rest. Severity now outranks the focused event and system explanations, and the capsule returns to the most important event after being closed.
- **Corners are concentric.** An inner radius is its outer radius less the gap between them, checked in the browser suite.
- The regeneration screen no longer shows the seed.

### Scroll limits behave like a scroll view

- **Edge resistance now follows how scroll views work.** Content carries on past a limit at the speed it arrived, with how far it travels limited by a rubber-band curve, and a critically damped spring brings it home. It used to stop dead and then make a small, unrelated movement. One gesture gets one motion, however unevenly its momentum fades, and the spring acts on the position shown, so the return is one curve. A region's frame now stays still while what is inside it moves.
- **Fixed:** turning reduced motion off replayed the map's arrival, flashing it through a blur.
- The notification history is one surface with one column of details. Settings headings, rows and the title share one left edge. Copying the seed has a new animation. Decimal units read `KB`.

### Generating a new world is one continuous animation

The particles lift off the current map's roads, form the name, blast apart, recollect into the name, and the film carries on, with progress along the bottom, until they land on the new world's roads. There is no title screen. It takes about 11 seconds at its fastest. A failed generation still shows its message with Retry and Return to current world, and the current world is untouched.

### Scrolling redesigned

- **Scrolling is more responsive everywhere.** Under 4× CPU throttle at 10× speed on a Retina-scale window, on the About page, median input delay fell from 92 to 35 ms, the worst case from 203 to 68 ms, and main-thread paint from 766 to 23 ms.
- The status pulse no longer repaints the page on every frame, and the day's progress and the backpressure monitor no longer run per-frame loops.
- Fade masks, custom scrollbars and blur behind panels are gone. Panels are solid and scrims are a plain dim.
- **Fixed: rules removing blur and masks did nothing in Chrome,** including Reduce Transparency. The minifier dropped the standard property when a `-webkit-` version was written beside it. Only the standard property is written now, the prefix is generated, and a test keeps it that way.
- Flow markers wait while anything scrolls or a dialog is open, and rows do not restyle under the pointer during a scroll.
- **The coordinates, scale and OpenStreetMap credit** now sit centred between the notifications and Roads, Places and Layers.
- **Settings:** Keyboard, Applications and Reset are one design with even spacing.

### Scrolling, map performance and the start-up film

- **Scrolling never waits for the page.** Edge resistance used to block every wheel event on the main thread and move every child of a list. It now only listens, and moves the region as a whole with one compositor transform, by at most 12 px. Under 4× CPU throttle at 10× speed, scrolling at a limit went from 42 to 54 fps and map zoom from 52 to 59 fps.
- **The map draws in tiles and layers.** Roads and buildings are grouped by tile and style, what changes with a snapshot is drawn once per snapshot, and only rain, incident pulses and flow markers run per frame. Names and markers follow zoom and importance, within a budget, and names wait until the camera stops.
- **Degraded no longer touches the interface.** It reduces only the map's data and animation. It no longer closes panels, moves the camera or turns off interface motion.
- **Runtime status is steady.** Degraded must hold for 4 seconds and recovery for 10, and ASB waits longer each time a release has to be taken back.
- **The film plays through once,** with "Finishing setup" if the world is ready sooner. After that the screen leaves as soon as the world is ready. Copy no longer implies anything is real or live.
- **Smoother handovers,** from title to particles and from particles to map, and a short particle ending when the server stops.
- **Notifications close without a snap,** and the Auto Focus menu opens as a fluid panel.

### Latest interface round

- **Speed is capped at 10×.** The engine, API and launcher all refuse more.
- **Keyboard shortcuts,** shown and changeable in Settings. A key already in use swaps. Resetting them, or all settings, returns the defaults.
- **Start-up:** the title's logo dissolves into the particle wordmark, the first wait is one second, and all headlines are one or two words. Signals and Auto Focus replace the earlier 86,400, closure and backpressure scenes.
- **The day's progress** is now the sun's path, with a moon after dark.
- **Search** has filters, including Modelled, and scrolls properly. **Places** groups kinds by whether they affect traffic.
- **Roads, Places and Layers** are one connected control. **The telemetry panel** is wider, so `99+` counts fit.
- **About** is redesigned, with GitHub and documentation links and no reset. **The Auto Focus menu** is redesigned.
- **Appearance now defaults to Auto,** following the device. **The launcher** can open with default settings: `--default-settings`, or `launcher.default_settings`.
- **Light mode:** hovering no longer turns controls dark. Edge resistance returns within about 150 ms.

### Latest changes to start-up, backpressure and the tray

- **The map no longer empties under backpressure.** ASB's reset used to turn off every layer but signals. Roads and
  buildings now stay, and detail returns as soon as the interface is back in sync.
- **Speed reductions are explicit.** The slider keeps its thumb on your target and marks the speed applied, and the bar reads
  for example `ASB 5×/10×`.
- **Intentional system design** notes are now notifications in the tray, which Do Not Disturb does not silence.
- **The opening:** a still title first, then the film, with stages paced so a fast start can still be seen. The launcher
  waits 4.5 seconds after the observer loads before requesting a world. Five new scenes, including words in 3D particles, and
  shorter captions.
- **The minimum window is now 1280 × 640,** so the whole bottom bar fits with its labels.
- **Notifications stop when the day ends.** The tutorial covers WebFabric, and the Apps tab is always present.
- **The launcher** no longer reports a server it can see running as gone because it missed some polls.
- The completion dialog is redesigned, edge resistance returns faster, the tutorial outlines the runtime status as it is,
  and OpenStreetMap attribution sits with the coordinates and scale.

### Fixed: seeds that could never start

- A seed whose coordinates fell on an isolated pocket of road failed with "mostly water or unmapped", even inside
  a dense city such as Singapore. The district now grows from the nearest road belonging to a network large
  enough. Those seeds now run; **results for every seed that already worked are unchanged**.
- The launcher no longer advises checking the network when a map downloaded correctly but cannot be used, and the
  observer no longer says such a failure clears by itself.

### Added in the latest interface round

- **Start-up film.** A WebGL2 particle scene re-forms into the wordmark, streets, a city, traffic, weather, a
  world of seeds and the WebFabric weave, with captions. Stage progress runs along the bottom. When the map is
  ready, the particles fly to its real roads and give way to it.
- **`ISDHandler`** (Intentional System Design Handler). A notification when the system does something on purpose
  that looks like a fault: Async, Restricted, a held or reduced speed, held reduced motion, a window that is too
  small, stepped movement above 5×, and an application that stopped checking in.
- **WebFabric on the road network.** Overlay features `marker` (on a node), `entity` (on an edge) and `route`, and
  an animated `path` over adjacent nodes with loop, bounce, speed, dwell, delay, spring and reveal options. New
  refusal: `422 NOT_ON_NETWORK`. New widgets: `route` and `sparkline`.
- **WebFabric on the collapsed telemetry strip**, opening the panel where applications show their content.

### Changed in the latest interface round

- **Bottom bar:** a flexible 24-hour timeline with a playhead replaces the top progress line, and the bar is 56 px tall.
- **Live Telemetry:** figures are one compact row, leaving more room for the detail below.
- **Places** is now the same panel as **Layers**, opening above the bar. Both have labelled icon actions.
- **WebFabric settings** are redesigned, with waiting applications first and permissions grouped by what they need.
- **The tutorial** matches the interface, is grouped by chapter, and its text is rewritten.
- **Settings:** colour vision options explain what each means and preview their colours. Data units read
  `kB, MB, GB` or `KiB, MiB, GiB`.
- **Curvature** is one scale across the interface, enforced by a test.
- **The reduced motion icon** moves continuously between its wave and flat states.

### Fixed in the latest interface round

- A closed notification was pushed out of its box by its body's padding.
- Technical details in a notification now open as the card does, and hovering them no longer looks wrong.
- Edge resistance paused after scrolling, since it waited for trackpad momentum to end. It now returns at once.
- The clock's second line left its box on hover.
- The location in the header was not centred on the header's line.
- Opening the WebFabric panel from the collapsed strip would have thrown, because its heading looked up an icon that
  was not there.
- `browser-webfabric.mjs` failed on a second run, because it inherited the registrations of the first.

**Results change for some seeds.** A signal whose compiled offset rounded up to a
whole cycle made the engine read past the end of that signal's phase table (found
with AddressSanitizer). The offset now wraps to the start of the cycle. Seeds
without such a signal are unchanged, and no scenario hash changes, because the
compiled offsets themselves are untouched; but a run that hit the over-read
behaved according to whatever memory followed the table, so its results were
undefined before and differ now.

### Added

- **Accessibility settings**: light mode; colour-vision palettes for protanopia, deuteranopia,
  tritanopia and monochrome; reduce transparency; and an advanced mode which, off, removes
  demand multipliers, radii, identifiers and technical details.
- **Dynamic Edge Resistance**: past any limit, content gives ever less then settles home, on the
  curve Apple's scroll views use, in every scrolling region, the sliders and map panning. The page
  itself never scrolls.
- Settings and search grow from the dock like a drop, and stay open while the map is used. Search
  offers popular places in the district and ranks live results.
- A section of the telemetry deck for WebFabric applications, and notifications marked as theirs.
  Elements choose how they arrive from provided motions, or a spring within the guidelines.
- Applications can name their own bus stops and read the demand a stop there would see, by the model
  real stops use. `Fabric/examples/bus_planner.py` is a whole product built on Fabric: it plans lines along
  real roads, draws them and runs buses along them.
- Fine control for Back and Forward, asking how far on each press. Data sizes in MB by default, or MiB.
- Zooming out is limited to 5% past fit, with resistance to a hard 10%.
- A speed slider with stops from 0.25× to 20×, including new 10× and 20× rates, that settles with
  the momentum of the gesture.
- Badges for states such as Realistic News not being supported on this device, an uninstalled SUMO,
  speed or motion held by backpressure, and applications waiting for permission.
- An interactive start-up screen: a street network on springs that responds to the pointer and
  lights up with the real stages, with elapsed time and facts during a long wait.
- WebFabric sidebar: room beside the map for an application such as a bus planner, with tabs, lists,
  statistics, legends and inputs, numbered series colours, overlay points that glide, map picking, and
  a state poll that sends only what changed.
- **Fabric**: the HTTP API as its own library in `Fabric/`, one module per API group,
  with a recorded contract test. See [Fabric](https://dstns.readthedocs.io/components/fabric/).
- **WebFabric**: independent applications in the observer. An application registers
  itself through `/api/v1/fabric/apps`, and declares status lines, header items, dock
  controls, edge indicators, map overlays, panels, dialogs and settings as data.
  Identity, grants and settings persist; a page of its own runs in a sandboxed frame;
  control of the simulation needs a capability a person grants, and is recorded. See
  [WebFabric](https://dstns.readthedocs.io/components/webfabric/) and
  [Building applications](https://dstns.readthedocs.io/development/webfabric-apps/).
- **Settings → Applications → WebFabric**: search, per-application settings drawn from a
  schema, permissions, suspend, resume and forget.
- A Fabric and a WebFabric logo in About, and a black and white favicon set in
  `docs/assets/brand/favicons/`.
- Failure and shutdown screens. Nothing loading, or a terminated server, now says so in
  full rather than as a small error or a connection that never returns.
- The map coasts when thrown, zooms smoothly about the pointer, and its camera redirects
  in flight. The settings drawer can be dragged shut.

- Natural-language narration of news. Incidents, storms, floods and surges are
  worded in plain language by Apple's on-device Foundation Model through `fm
  serve`, started and stopped by the server where `fm` is installed, or by any
  OpenAI-style Chat Completions endpoint (`--narrator`, `--narrator-model`,
  `--narrator-cache`, `DSTNS_NARRATOR*`). Presentation only: the model sees facts
  after the simulation has fixed them, its sentences are checked against those
  facts (invented numbers, injuries, speculation and advice are refused), and the
  simulation never reads them; runs are byte-identical with it on or off.
  Scheduled incidents and storms are narrated ahead of time at install; narrations
  are cached by their facts in memory and in SQLite, so seeks, replays and
  restarts reuse them. News items gain an optional `narrative`; `/api/v1/news`
  gains the `since_narration` cursor with `narrated` and `narration_sequence`;
  `GET /api/v1/system/narrator` reports the model, queue and cache. The observer
  shows narrations as notification summaries and keeps the core's text under the
  technical details.
- `dstns_benchmark` measures the system under increasing load: district size,
  storms and incidents, concurrent observers, and the narrator (with `--narrator`,
  a real model end to end). `--json` writes every figure with the machine and build.
- `DSTNS_TUNE_FOR_HOST` CMake option for `-mcpu=native` builds.
- The launcher chooses narration before it starts a server: `--narrator`, or
  `narration.mode` in `config/defaults.json` (default `auto`). It checks for the
  `fm` command, `fm available` and Apple's terms (or that an endpoint answers),
  and when narration is unavailable or unsupported starts the server with it off,
  keeps the default wording, and says why and how to fix it. After the run starts
  it reports what the server's narrator actually did. A **Narration** environment
  check shows the same decision.

- Realistic News. The observer's **Settings → News** switches between Realistic
  News, written by the on-device model like a local traffic report, and Standard,
  predefined wordings that vary from event to event (`news.style` in
  `config/ui-config.json`). Realistic News is written from the event and its
  context - the city, road, district, hour, day type, named places nearby, the
  weather at the time, earlier incidents that day - may add plausible colour but
  not contradict the facts, invent numbers or mention deaths, and now also covers
  the busiest hours at named schools, hospitals, shopping centres and stations.
  It is the observer's alone: `/api/v1/news` serves narratives only with
  `narration=realistic`, and snapshots never do. Notifications written this way
  are marked **Realistic News**.
- The launcher reports Apple Foundation Models as **Available**, **Unavailable** or
  **Disabled**, in start-up messages and as an environment check.

### Changed

- The engine and core features moved to `Core/`, and the server entry point to
  `Core/server/`. Build targets and flags are unchanged.
- The command rail and the bar above it share their edges. The rail shows all speeds on a labelled
  slider, with a full-width progress line. The top bar, the Layers, Places and Roads menus, dropdowns and
  the hover card are redrawn; the hover card now describes the place you point at. Surfaces are solid
  rather than frosted, and per-frame updates no longer re-render the interface, which removes most of
  the lag. Light mode is designed in its own right, and the boot screen uses the full logo.
- The lower HUD is one quiet row, with coordinates and scale as a caption on the map. Settings are
  grouped, with more room. About explains Fabric and WebFabric. The end-of-day dialog is redrawn, with
  figures that count up. Icons move on hover and selection, and their centres match their hover areas.
- Rain cells, the map fit and zoom, the progress ring and collapse and expand all move on springs. The
  interface arrives around the map in a stagger, and the map quietens when the day ends.
- Do Not Disturb stops new notifications without removing one already on screen. An open notification
  shows its full text and stays still: newer events wait behind a count.
- All motion is one spring model. Dialogs and popovers enter through interruptible
  transitions, so they reverse from wherever they have got to.
- Start-up is one surface naming the real stage. The Welcome hold and staged delays are
  gone, and the interface polls faster until a map exists: 3.3 s to 1.55 s from starting
  a run to interactive, in Chrome on the bundled map. Idle no longer shows a spinner.
- Text in Settings no longer competes with the map behind it. Switches, segmented
  controls and text buttons meet the 24 px target minimum.
- The observer's page is served with a Content Security Policy.

- The topology response is built once per world and served from a cache: about
  0.1 ms instead of 87 ms for a 2,500-junction grid, without rebuilding it under
  the engine lock.
- Snapshots copy the dynamic state under the engine lock and build their JSON
  after releasing it, in parallel slices on several cores for large networks.
- The engine catches up on the clock in slices of about 20 ms, releasing its lock
  between them, so a snapshot, pause or seek waits for one slice instead of the
  whole catch-up. The ticks and their order are unchanged.
- A physics tick is about 22% faster: storms and surges are shaped once per tick
  instead of per junction or edge, per-edge signal groups and traversable
  directions are fixed at install, and the hot loops index state directly.
  Results are bit-identical.
- On Apple silicon the physics clock runs at interactive quality of service (the
  performance cores) and narration at utility (the efficiency cores).

### Fixed

- A signal's phase walk no longer reads past its phase table (see above).
- The launcher no longer floods the terminal with logging tracebacks, or fails to
  install its terminal interface, in a checkout synced by OneDrive, iCloud Drive or
  Dropbox. Its log and private environment are kept on local disk there
  (`~/Library/Logs/DSTNS`, `~/Library/Caches/DSTNS`; `DSTNS_LAUNCHER_VENV` overrides),
  a log that cannot be written goes quiet instead of raising, and the **Workspace**
  check warns when the server's runtime files have been evicted to the cloud.
- The simulation core would not build or start from a checkout synced by OneDrive,
  iCloud Drive or Dropbox: CMake could not create its files in `build/`, and the
  server's logs and the observer were read from evicted files. In a synced
  checkout the launcher now builds the core and the observer, caches maps, and
  keeps the server's logs on local disk (`DSTNS_BUILD_DIR`, `DSTNS_LOGS_DIR`
  override; the server reads the observer's location from `DSTNS_UI_DIST`), and
  keeps Python's bytecode there too.
- An observer that cannot be built (Node.js missing or no longer starting) no
  longer stops the simulation from starting; the launcher names the cause and the
  fix, and serves the previous build if there is one.
- `./launcher start` without a terminal no longer hangs on SIGTERM: it waited on
  the server holding a lock its own signal handler needed.
- The server's model watchdog no longer leaves `fm serve` running when DSTNS has
  exited but not yet been reaped.

- GHCR publishing now builds and tests native Linux AMD64 and ARM64 images,
  then verifies the multi-platform manifest before promoting stable tags.
- Compose pulls `ghcr.io/varunkarthic/dstns:stable` by default; use the explicit
  `docker-compose.build.yml` override for local or optional SUMO builds.

### Added

- Stable/latest, branch, short/full SHA and semantic-version release tags;
  OCI developer attribution for Varun Karthic, SBOM and build provenance.
- Packaged build manifest, licence and copyright; revision, timestamp, channel
  and architecture in CLI/API build information. Engine version stays 2.1.0.
- Container gates for health, offline simulation, observer assets, metadata,
  non-root execution, run replacement and shutdown. Direct GHCR pull/run docs.

## [2.1.0] - 2026-10-02

Engine 2.1.0 and observer 2.3.0, API contract 1.0. The first public release.

**Results change for some maps.** Maps containing untagged roundabouts produce a
different graph in this release, because those roundabouts are now one-way as
OpenStreetMap requires. Their `graph_hash`, `scenario_hash` and simulation results
differ from 2.0.0. Maps without untagged roundabouts, including the bundled fixtures,
are unchanged.

### Security

- **The server binds to `127.0.0.1` by default.** `dstns_server`,
  `config/defaults.json` and the Docker Compose port mapping previously
  exposed the API on every interface. Set `--host`, `api.host` or
  `DSTNS_BIND=0.0.0.0` to expose it deliberately. The container still listens on
  `0.0.0.0` internally behind the loopback mapping.
- **DNS rebinding is refused.** When bound to loopback, requests whose `Host`
  header is not `localhost`, a `*.localhost` name or an IP literal receive HTTP
  421 `HOST_NOT_ALLOWED`. `DSTNS_ALLOWED_HOSTS` admits additional names.
- **CORS is no longer granted to every origin.** `Access-Control-Allow-Origin: *`
  let any web page read a local server's run state. The header is now sent only
  for the server's own origin and `DSTNS_ALLOWED_ORIGINS`.
- **Cross-site request forgery.** State-changing requests carrying a browser
  `Origin` other than the server's own are refused with 403
  `CROSS_ORIGIN_FORBIDDEN`. `GET /terminate` and `GET /api/v1/system/terminate`
  were removed; shutdown is `POST` only.
- **Command injection** through the SUMO export directory is closed: every
  argument passed to a shell is quoted.
- Integer wrap-around in path IDs, times, query numbers and undo or redo counts
  is refused with HTTP 400 instead of acting on the wrong object.
- Log messages are flattened to one line, so a request path cannot forge entries.
- Published a [security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md) and added CodeQL analysis.

### Added

- **Public release.** DSTNS is released for public use under the AGPL. It is
  developed independently and does not take outside contributions, bug reports or
  feature requests.
- **Licence headers.** Every source file carries an SPDX identifier and copyright line;
  `scripts/license-headers.py --check` runs in CI. `COPYRIGHT` and the licence page
  explain how the licence is applied.
- **Docker, supported.** A multi-architecture image (234 MB) with the engine, the
  observer, the map downloader and an offline district; auto-start configured by
  `DSTNS_*` variables; `dstns-run` for starting runs; an optional TLS gateway as a
  Compose profile; optional SUMO.
- **Documentation site** on Read the Docs: getting started and system requirements,
  a user guide, concepts with the model's equations and assumptions, an API
  reference with an OpenAPI explorer, deployment, upgrading and security guides,
  troubleshooting, an FAQ, known limitations, reference tables, design decisions and
  the quality assurance record.
- Continuous integration on GitHub Actions for the native, HTTP, observer,
  documentation and container builds.
- CodeQL static analysis of the C++, JavaScript and TypeScript, Python and workflow code.
- `tests/api/hardening_smoke.py`, covering origin and host checks, CORS, input
  validation and shutdown against a real server.

### Changed

- The CLI's `playback.tick_rate` and `--speed` bound is 5, matching the engine
  (it was 10).
- `dstns_replay_verify` accepts decimal seeds and `--help`.
- Building no longer links OpenSSL or zstd opportunistically; the engine needs
  neither.

### Fixed

- **Southern-hemisphere cities could never be downloaded** on Python before 3.13
  (Debian, Ubuntu, the container): the bounding box's leading minus sign was
  parsed as an option. 25 of 181 cities, about one seed in seven, were affected.
- Exported SUMO bus stops were rejected by SUMO (`Invalid position for busStop`),
  failing every SUMO run on a real map. SUMO release versions were misreported.
- Undoing a signal toggle did nothing.
- Seeking backwards erased operator road overrides; seeking to 24:00:00 did not
  complete the day.
- Surge and weather parameters were unbounded and could overflow.
- **Results change for maps with untagged roundabouts**, which are now one-way as
  OpenStreetMap convention requires, and `shop=mall` nodes are malls, not stores.
- SUMO was reported available when it could not start; failed SUMO runs reported
  success; SUMO runs held the engine lock and froze the API.
- Dialogs slid under the header, hiding the About logo, and dialogs opened from
  the completion screen vanished after 180 ms.
- `--port 70000` wrapped to 4464; stale `.progress` files accumulated in the map
  cache.
- The observer reports the HTTP status of an error that has no JSON body.
- Saving a seed whose city is chosen by the seed (`--save-seed` without
  `--osm-file`) failed with `No such file or directory`. Such saved seeds now
  record the seed and selection version, and replay through the map cache.
- `global_view.json` and the shutdown response reported an outdated product name,
  and `global_view.json` an outdated version.
- The observer dependency DOMPurify was updated from 3.4.15 to 3.4.16
  ([#1](https://github.com/varunkarthic/DSTNS/pull/1)).

### Removed

- The separate UI container and its unused in-memory overlay service, the second
  Compose file, the retired static design mock-up and generated SUMO outputs. The
  original design specifications are published under
  [Design specifications](https://dstns.readthedocs.io/design/).

## [2.0.0] - 2026-09-20

Engine 2.0.0 and observer 2.2.0.

### Added

- **Seed-selected real places:** a catalogue of 181 cities, on-demand
  OpenStreetMap downloads, CRFG district growth and a true-metre projection.
- Raw numeric seeds end to end, saved seeds, and UTF-8 safety for untrusted map
  text.
- Adaptive Simulation Backpressure (ASB) keeping the observer in step.
- Realistic signals: controllers snapped to junctions, green waves and
  demand-proportional splits.
- Place-aware demand with explainable couplings, and realistic bus-stop spacing.
- The observer: command rail, world regeneration, time-travel controls, settings,
  Do Not Disturb, Auto Focus, notification history, telemetry collapse, place
  legend, guided tutorial, PDF report, a finished-run screen and a UI-first
  start-up.
- The operator CLI: an interactive console, start-up verification, saved seeds,
  test runner and log inspector.
- Deterministic incident subsystem (at least four a day) and standardised
  weather (DWS).
- AGPL-3.0-or-later licensing with a network source offer.

## [1.0.0] - 2026-09-07

The first deterministic vertical slice: seeded scenario compilation from a
synthetic grid or OSM XML, the aggregate traffic model, checkpoint replay, the
HTTP API, the SUMO export and the first observer.

[Unreleased]: https://github.com/varunkarthic/DSTNS/compare/main...HEAD
[2.1.0]: https://github.com/varunkarthic/DSTNS/commits/main
[2.0.0]: https://github.com/varunkarthic/DSTNS/commits/main
[1.0.0]: https://github.com/varunkarthic/DSTNS/commits/main
