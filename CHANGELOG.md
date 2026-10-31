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

**Observer 3.0.0, API contract 1.1.** Fabric and WebFabric leave the engine at 2.1.0, and
every existing endpoint behaves as before: 155 recorded calls are replayed against the
server to prove it. `api_version` in responses now reads `1.1`.

**Results change for some seeds.** A signal whose compiled offset rounded up to a
whole cycle made the engine read past the end of that signal's phase table (found
with AddressSanitizer). The offset now wraps to the start of the cycle. Seeds
without such a signal are unchanged, and no scenario hash changes, because the
compiled offsets themselves are untouched; but a run that hit the over-read
behaved according to whatever memory followed the table, so its results were
undefined before and differ now.

### Added

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
