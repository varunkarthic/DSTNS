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

The coupled city: a deterministic calendar, terrain, the Sun, surface water,
drainage, urban wind, demand, emergency response and causal incidents
exchanging state through one clock. Added one stable piece at a time; each
entry says whether it changes results for an existing seed.

**Changed: standing water.** With the new `hydrology` module on (the default),
flooding comes from simulated surface water instead of the node flood model,
and roads slow on their grade: results change wherever it rains or the ground
is not flat. With `hydrology` and `vehicle_dynamics` off and flat terrain, the
traffic step computes exactly what 2.2 did.

**Changed: the day type of an unconfigured run is now the seed's own.** Before,
a run that did not name its day type was always a weekday. A run that names it
(`--day-type weekday`, `"day": 0`) is unchanged. Scenario hashes, and so run
IDs, now also include the month.

### Added

- **Deterministic calendar.** A seed now determines a month and a day type as
  well as a location, each from its own derived stream (`calendar.month`,
  `calendar.day`, `map.city`), so none shifts when another module draws more
  numbers. There is no day of the month. The status, manifest, start response
  and global view carry a `calendar` block saying whether each value came from
  the seed or the configuration; the observer's header shows the month and day
  type.
- **Constrained seeds.** `./launcher start --location Ahmedabad --month July
  --day-type weekday` searches for a seed whose own metadata matches (about
  3,000 candidates, a few milliseconds), so the seed alone reproduces the
  constraints. Also `POST /api/v1/seeds/generate`, `GET /api/v1/seeds/describe`,
  `GET /api/v1/seeds/locations`, `dstns_server --generate-seed` and
  `--describe-seed`, Docker `DSTNS_LOCATION` and `DSTNS_MONTH`, and the
  observer's new-world dialog (Random, Enter or Constrained seed).
- `"month"` in start requests and `"seed"` in `POST /api/v1/world/regenerate`.
- **Terrain (DEM).** Every district gets an elevation model on a shared
  environment grid (25 m cells by default) from a provider: AWS Open Data
  Terrain Tiles (cached in `data/dem`, attributed to Mapzen and its sources),
  flat terrain, or analytic test surfaces. Each directed road has a grade, its
  twin the negation. A DEM that cannot be loaded falls back to flat terrain and
  marks the run degraded, unless `environment.dem_required` is set.
  `GET /api/v1/view/environment`, `GET /api/v1/view/fields/{elevation,slope}`,
  `dstns_server --dem-cache`, `DSTNS_DEM_SOURCE`. Existing worlds are unchanged
  until a later module reads the grade; scenario hashes include the terrain.
- **Sun and surface (DCM).** Solar position for the month's representative
  day, clear-sky irradiance attenuated by storm cloud and projected on the
  terrain, and an asphalt surface energy balance, updated every minute and
  checkpointed with the rest of the run. Fields `irradiance`,
  `surface_temperature`, `cloud`; a `dcm` module; the observer's **City** tab
  with a sun-path card. Traffic is unaffected.
- **Surface water (DWS).** Rain runs over the terrain under the local-inertial
  shallow-water equations, ponds in hollows and leaves only by physical routes
  (the district's edge, open water, evaporation, infiltration), with an exact
  integer water ledger whose conservation error is zero. It runs on the CPU, or
  bit-identically on a Vulkan device for grids from 131,072 cells
  (`dstns_benchmark hydrology`). Field `water_depth`; module `hydrology`.
- **Drainage (DDS).** Street water now enters a synthetic drainage network
  instead of disappearing: grates along every street, pipes laid under the
  streets towards outfalls on the district's edge and open water, sized for a
  25 mm/h design storm. Pipes carry head-driven Manning flow with finite
  capacity; an overloaded network surcharges and returns water to the street
  (`DRAIN_SURCHARGE` news). Volumes move between street and pipe exactly, and
  both ledgers report a conservation error of zero. The network is synthetic,
  and labelled so everywhere. `GET /api/v1/view/drainage`; module `dds`; the
  observer's **Drains (synthetic)** layer and Drainage card.
- **Vehicle dynamics and road state.** Roads respond to their grade (a power-
  limited longitudinal model for four vehicle classes) and to the water on them
  (Pregnolato et al.'s depth-speed relation; cars stop at 300 mm), through four
  new inputs to the traffic step. `GET /api/v1/view/road-environment`; module
  `vehicle_dynamics`.
- **Observer: field overlays and a compass.** Layers gains an exclusive field
  overlay group; Elevation draws a heatmap with a legend and a pointer readout.
- RNG domains for the new modules, appended after the existing ones. Golden
  values recorded before the change prove the existing streams did not move.

### Fixed

- `PUT /api/v1/control/modules/{module}` rejected module names with an
  underscore, so `vehicle_dynamics` could not be switched at run time.

## [2.2.0] - 2026-10-02

Engine 2.2.0 and observer 2.4.0, API contract 1.0. GPU acceleration.

**Results change for every seed, slightly.** The physics step is now integer
fixed point, so that a GPU computes exactly what the CPU does. Values agree
with 2.1.0's double-precision model to about 10⁻⁷, and discrete quantities
such as vehicle counts can differ where a value sat on a rounding boundary.
Scenario, graph and event hashes are unchanged. Separately, runs in which a
signal's planned offset was exactly one cycle (see Fixed) now behave
reproducibly, and may differ from any given 2.1.0 run of the same seed.

### Added

- **GPU acceleration through Vulkan.** The per-node weather and flood step and
  the per-edge environment and traffic step can run on any Vulkan 1.2 GPU with
  64-bit shader integers: NVIDIA, AMD and Intel on Linux, Apple GPUs through
  MoltenVK and Metal, GPUs exposed by WSL 2. No CUDA, no vendor extension, no
  Vulkan SDK needed to build or run. A device is used only after a self-test
  dispatch returns the right answer.
- **Bit-identical backends.** The step is written once, in
  `shaders/include/dstns_physics.h`, and compiled both as C++ and as GLSL, so
  the CPU and every GPU execute the same integer operations. New suites hold
  them to it on every device present, under the Khronos validation layers.
- **Automatic backend choice.** `compute.backend` is `auto` (the default),
  `cpu` or `vulkan`. `auto` keeps worlds below 40,000 junctions and 150,000
  edges on the CPU and, above, times both on the world itself and keeps the
  faster. Measured on an Apple M4: the GPU is slower below about 50,000
  junctions and 1.2 to 1.5 times faster than eight CPU threads up to a million.
- **Fault tolerance.** A failed GPU step leaves the committed state intact and
  is recomputed on the CPU. A lost device is recovered exactly, operator
  actions included, by replaying a journal of each step's inputs on the CPU.
  A failed device is retired, never retried every second.
- `GET /api/v1/system/compute`, and a `compute` object in `/system/info`:
  active backend, device, why it was chosen, calibration, per-pass GPU time,
  transfer volumes, fallbacks. `503 COMPUTE_RECOVERING` while recovering.
- Server flags `--compute`, `--gpu-device`, `--require-vulkan`,
  `--allow-software-vulkan`, `--compute-verify`, `--vulkan-validation`,
  `--compute-cache` and `--gpu-diagnostics`, and the matching `DSTNS_COMPUTE_*`,
  `DSTNS_GPU_*` and `DSTNS_VULKAN_*` environment variables.
- Launcher: a `compute` section in `config/defaults.json` and a Compute page
  in the configuration screen (GPU acceleration on or off, backend, device);
  `start --compute` and `--gpu-device`; a GPU acceleration section in the
  environment check, backed by a real, cached device test;
  `./launcher diagnostics gpu`; and `./launcher bootstrap`, which installs
  missing dependencies with Homebrew, apt, dnf or pacman after showing the plan,
  and never installs GPU drivers.
- Observer: the active compute backend in the telemetry deck's stack view and
  in About.
- `dstns_benchmark compute`: every backend timed on worlds from 1,000 to
  1,000,000 junctions.
- Structured-grid field kernels (`compute::FieldSolver`), the base for future
  terrain-water and atmospheric models: an integer diffusion step, identical on
  the CPU and every GPU, run many iterations per submission.
- CI runs the Vulkan suites on Mesa's llvmpipe with validation layers, and
  checks that the committed SPIR-V matches its sources.
- Documentation: Compute architecture, GPU acceleration, Vulkan backend, and
  updated performance, reproducibility, configuration and reference pages.

### Changed

- `GraphStore` no longer owns the dynamic state during a run: the compute
  dispatcher does, and the graph serves a view refreshed on demand. Its public
  reading interface is unchanged.
- Checkpoints hold the fixed-point state: 68 bytes per edge instead of 184.
- The CPU backend splits worlds of more than 32,768 edges across up to eight
  threads, without changing results.
- The container image builds the Vulkan backend; `WITH_VULKAN=1` adds the
  loader and Mesa's drivers for GPUs passed in with `--device /dev/dri`.
- The launcher rebuilds the core when `shaders/` or `cmake/` change.

### Fixed

- **A signal planned with an offset of exactly one cycle read past its phase
  list.** `llround(fmod(travel, cycle))` can round up to the full cycle, and the
  event runtime then walked past the sixth phase into memory beyond it: two runs
  of the same seed could differ. The offset now wraps into the cycle, which is
  what it means. Found by the new CPU/GPU comparison, whose two engines
  allocate differently.

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
