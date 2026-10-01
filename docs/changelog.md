# Changelog

Notable changes to DSTNS. Dates are when the change reached the main line.
The engine reports its version as `DSTNS_VERSION` (CMake project version) and
the observer as `VERSION` in `ui-engine/src/App.tsx`.

## Unreleased — October 2026

Repository moved to [varunkarthic/DSTNS](https://github.com/varunkarthic/DSTNS).
A full code evaluation is recorded in [Code evaluation, October
2026](development/audit-2026-10.md).

### Added

- **Docker, supported.** A multi-architecture image (234 MB) with the engine,
  the observer, the map downloader and an offline district; auto-start
  configured by `DSTNS_*` variables; `dstns-run` for new runs; an optional TLS
  gateway as a Compose profile; optional SUMO. See [Docker](deployment/docker.md).
- **Documentation site** for Read the Docs: getting started, user guide,
  concepts, full API reference with an OpenAPI explorer, deployment,
  troubleshooting, FAQ, development and component notes.
- **Continuous integration** on GitHub Actions: native, HTTP, observer and
  documentation builds on every push.
- `tests/api/hardening_smoke.py`: cross-site writes, input validation and
  shutdown method, against a real server.

### Fixed

- **Southern-hemisphere cities could never be downloaded** on Python before
  3.13 (Debian, Ubuntu, the container): the bounding box's leading minus sign
  was parsed as an option. 25 of 181 cities were affected.
- **Cross-site request forgery:** any web page could pause, seek, override
  roads or shut down a local server. State-changing requests now require the
  observer's own origin. `GET /terminate` is gone.
- **Command injection** through the SUMO export directory.
- Undoing a signal toggle did nothing; a negative undo count undid everything.
- Seeking backwards erased operator road overrides; seeking to 24:00 did not
  complete the day.
- 32-bit ID, time and query-number wrap-arounds in the API.
- Untagged roundabouts were two-way; `shop=mall` nodes were stores.
- SUMO reported available when it could not start; failed SUMO runs reported
  success; SUMO runs froze the API.
- Dialogs slid under the header (the About logo was hidden); dialogs opened
  from the completion screen vanished after 180 ms.
- The CLI accepted speeds up to 10× while the engine allows 5×; `--port 70000`
  wrapped to 4464; stale `.progress` files accumulated in the map cache.

### Removed

- The separate UI container and its unused in-memory overlay service, the
  second compose file, the retired `ui-engine-alpha` mock-up, generated SUMO
  outputs, and stale assistant hand-off notes. The original design
  specifications moved to [Design specifications](design/index.md).

## 2.2.0 (observer) / 2.0.0 (engine) — September 2026

### Added

- **Seed-selected real places:** a catalogue of 181 cities, on-demand
  OpenStreetMap downloads, CRFG district growth, true-metre projection.
- **Raw numeric seeds** end to end, saved seeds, and UTF-8 safety for
  untrusted map text.
- **Adaptive Simulation Backpressure (ASB)** keeping the observer in step.
- **Realistic signals:** controllers snapped to junctions, green waves,
  demand-proportional splits.
- **Place-aware demand** with explainable couplings, and realistic bus-stop
  spacing.
- **The observer:** command rail, world regeneration, time travel controls,
  settings, Do Not Disturb, Auto Focus, notification history, telemetry
  collapse, place legend, guided tutorial, PDF report, a finished-run screen,
  and a UI-first start-up that narrates world preparation.
- **The operator CLI:** an interactive console, start-up verification, saved
  seeds, test runner and log inspector.
- Deterministic incident subsystem (at least four a day) and standardised
  weather (DWS).
- AGPL-3.0-or-later licensing with a network source offer.

## 1.x — early September 2026

The first deterministic vertical slice: seeded scenario compilation from a
synthetic grid or OSM XML, the aggregate traffic model, checkpoint replay,
the HTTP API, the SUMO export and the first observer.
