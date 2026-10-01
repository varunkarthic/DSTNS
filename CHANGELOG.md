# Changelog

All notable changes to DSTNS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
DSTNS uses version numbers that identify three independently versioned parts:
the engine (`DSTNS_VERSION`, set in `CMakeLists.txt`), the observer (`VERSION` in
`ui-engine/src/App.tsx`) and the HTTP API contract (`/api/v1`). Changes that
alter simulation results for an existing seed or map are called out explicitly,
because the [reproducibility guarantee](https://dstns.readthedocs.io/en/latest/concepts/reproducibility/) holds
only within one version.

## [Unreleased]

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
- Published a [security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md), CodeQL analysis, Dependabot
  configuration, and issue and pull request templates.

### Added

- **Docker, supported.** A multi-architecture image (234 MB) with the engine, the
  observer, the map downloader and an offline district; auto-start configured by
  `DSTNS_*` variables; `dstns-run` for starting runs; an optional TLS gateway as a
  Compose profile; optional SUMO.
- **Documentation site** for Read the Docs: getting started, user guide, concepts
  with the model's equations, API reference with an OpenAPI explorer, deployment,
  troubleshooting, FAQ, development and component notes.
- Continuous integration on GitHub Actions for the native, HTTP, observer,
  documentation and container builds.
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
- The observer dependency DOMPurify was updated from 3.4.15 to 3.4.16
  ([#1](https://github.com/varunkarthic/DSTNS/pull/1)).

### Removed

- The separate UI container and its unused in-memory overlay service, the second
  compose file, the retired `ui-engine-alpha` mock-up, generated SUMO outputs and
  stale assistant hand-off notes. The original design specifications moved to
  [Design specifications](https://dstns.readthedocs.io/en/latest/design/).

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
[2.0.0]: https://github.com/varunkarthic/DSTNS/commits/main
[1.0.0]: https://github.com/varunkarthic/DSTNS/commits/main
