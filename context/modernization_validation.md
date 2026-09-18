# Observer modernization validation — 2026-09-12

Branch: `feature/observer-modernization`, based on `dstns`. This records implemented behavior and observed gates, not a claim that the aggregate engine supplies microscopic SUMO telemetry. Historical context files describe earlier milestones; this checklist and `docs/modernization.md` describe the current implementation.

## Requirement checklist

- [x] Alpha analyzed: the actual reference is `ui-engine-alpha/templates/index.html`; the requested top-level file is absent. Its layout, surfaces, typography, controls and interaction direction informed React components.
- [x] Visual language integrated: reusable glass/theme tokens, floating module bar, congestion/metadata cards, event sidebar and playback bar. Actual Chrome screenshots at 1440×1000, 1280×633, 800×700 and 390×844.
- [x] Deterministic region selection: native repeatability/property gates plus complete large-map topology equality after actual `start --saved-seed` reuse. Adjacent seeds 382923/382924 selected disjoint road-node sets (Jaccard 0.0) from the same source.
- [x] Large real region: Berlin source selected 5,409 road nodes, 11,280 canonical directions (9,838 traversable), 12,479 features and 156 signal controllers. Source SHA/provenance in `data/maps/berlin-urban.osm.manifest.json`.
- [x] Road names retained in topology, zoomed labels and road hover; native metadata assertion and actual Chrome road hover passed.
- [x] Buildings: real simple-way footprints, category/tags and nameless fallback; native assertion, rendered map and PDF inspection. Complex relations remain a documented limitation below.
- [x] POIs: real OSM point/way features, names/types, search and demand state. Browser place inspection and large-map school alerts passed.
- [x] Geographic proportions: common local metric projection and uniform canvas scale; native projection invariant and visual geographic-map inspection.
- [x] Map performance: separate static/dynamic canvases, cached geometry, viewport culling, zoom/collision limits. Large map load 1.9–2.6 s in sampled headless Chrome runs; 182 frames over 3 s, median 16.7 ms / p95 16.8 ms; motion toggle 88–96 ms. These are local samples, not a universal performance guarantee.
- [x] CLI-only creation: browser has no creation method/control; startup/prepare require private operator header; uncredentialed browser start returns 403. Actual CLI → core → browser startup passed.
- [x] Browser weekday/weekend selector removed; active mode remains read-only metadata.
- [x] CLI default weekday: configuration/native test and actual default-day large run.
- [x] CLI weekend: actual browser test and container CLI start; invalid values rejected.
- [x] Saved seed IDs: SQLite save/list/inspect/use/delete, duplicates/invalid IDs, content pinning/integrity tests; actual saved-run reuse in native CLI, browser and container workflow.
- [x] Transit retirement: dependency analysis found only UI dispatch/engine records, removed dead state/client methods; compatibility route returns 410. Canonical routing and internal stops/trips retained. API smoke checks retirement.
- [x] Independent traffic lights: bounded capacity/degree/seed-derived plans, actual separate groups/phase offsets; native independent-phase tests and Chrome signal hover.
- [x] Signal transitions use heap scheduling; one successor per controller. Stress: 10,000 controllers and over 100,000 interleaved executions, bounded observer history.
- [x] Demand changes use the same deterministic heap; nearby edge demand changes through precomputed spatial weights. Native causal demand assertion and actual browser event/edge-state checks.
- [x] Event stack inspectable in UI with category filters and bounded pages.
- [x] Future versus history: separate tabs/statuses and API `view`; browser assertions inspect both. History explicitly retains the latest 2,000 executions.
- [x] Manual incident placement removed from browser methods, controls and map interactions.
- [x] Manual closure controls removed from browser; supported legacy operator endpoint retained.
- [x] Hover: actual road and signal pointer tests, keyboard place inspection, shared entity inspection implementation. Vehicle marks expose aggregate flow information; individual vehicle identities are unavailable (see below).
- [x] Custom tooltips: shared delayed portal component, focus/hover support, bounds positioning; browser confirms no `title` attributes and actual tooltip content.
- [x] Reduce Motion: hides vehicle-flow markers, disables nonessential transitions, preserves traffic state/alerts/weather; explicit preference persists after reload. Actual browser checks and static screenshots.
- [x] OS reduced-motion preference honored initially; explicit user override persists.
- [x] Green/amber/red/blue precedence: unit assertions include flood plus closure plus severe congestion; flood stays blue.
- [x] DWS is separate: actual weather radius/intensity regions and rainfall fields; rain alone does not imply severe congestion (unit regression).
- [x] Building demand visualization: static red POI alerts instead of large expanding demand circles. School event screenshot shows changed icons and underlying network effects.
- [x] Congestion 0–100: weighted traversable length × lanes, model speed/queue/occupancy; native bounds/weighting and property tests.
- [x] Average evolves: 900-virtual-second EMA, minute history, checkpoint restoration and speed-independent replay tests; before/after demand values observed in browser/PDF.
- [x] UI terminology uses “Average”; documentation explains EMA rather than a static baseline.
- [x] Important event toasts: bounded to three, expiring/dismissible, signal transitions excluded; actual demand-change toast tested in Chrome.
- [x] Event sidebar: filtering, future/history pagination and ≤30 rows tested; independent from simulation timing.
- [x] PDF redesign: three-page A4 report, embedded local Inter, actual metadata/history/map/events, consistent palette/hierarchy. Actual browser download, text extraction and all-page raster inspection passed.
- [x] Missing logo: `/media/logo.png` absent during all browser/report checks; text fallback and report still work.
- [x] Supported core/API flow: 83 API assertions, native lifecycle/property/replay tests; existing HTTP/SSE transport retained. JSON compression regression added after real payload measurement exposed an exact-media-type mismatch.
- [x] Tests: gates and limitations listed below; no unrun remote CI is presented as passing.
- [x] Documentation: root README, modernization/formulas/CLI/Docker/OSM/events/API guides and OpenAPI updated. YAML and all local schema references resolve. Historical context is identified as historical.
- [x] Obsolete code: browser creation/world-edit clients, Transit records/dispatch UI, fake congestion incident records/global signal messages and unused MapLibre dependency removed. No fake grid fallback in normal OSM CLI flow.

## Verification evidence

| Gate | Observed result |
| --- | --- |
| Release CMake build + CTest | 5/5 suites passed; latest 5.25 s |
| ASan/UBSan build + CTest | 5/5 suites passed; 17.09 s, no sanitizer finding |
| API lifecycle/integration | 83 assertions passed, including startup gate, Transit 410 and gzip negotiation |
| CLI seed store/arguments | 5 tests passed; large saved-run exact topology reuse also passed |
| UI production build + Vitest | Build passed; 11 tests passed |
| Actual Chrome browser suite | Passed startup/weekend/pause/resume/speed/motion/tooltips/signal hover/demand toasts/event views/search/layout/PDF/malformed-state recovery/completion/saved reuse/termination |
| Large-map Chrome probe | Passed road hover, actual school notifications, motion and PDF; no uncaught page errors |
| Replay verifier | Grid and OSM compilation/runtime repeatability passed |
| SUMO batch smoke | Export → netconvert → SUMO passed using an isolated temporary directory |
| Docker | Source image built with Linux amd64 and HTTPS npm mirror; container CLI starts/saves a weekend run and reaches running/healthy |
| Compose | Isolated project uses the repository service/health/volume configuration with different names and host port; healthy CLI-started run observed. Actual Chrome container smoke passed saved-weekend metadata, pause freeze, resume advancement, speed changes, event queue and PDF download with no page errors; `artifacts/modernization/container/result.json`. |
| OpenAPI | Parsed 40 paths and resolved all local references; no claim of external conformance-validator/remote CI execution |

Evidence artifacts: `artifacts/modernization/browser/` (browser screenshots, PDF, isolated logs); `artifacts/modernization/large/metrics.json`, `browser-metrics.json`, `large-map.png`, `road-hover.png`, `large-demand.png`, `large-report.pdf` and rendered report pages. Local command logs are copied to `artifacts/modernization/verification/`. Artifacts and the 105-MB raw OSM source are intentionally ignored by Git; the source manifest and reproducible import script are retained.

Large-source observations: initial CLI compile/start 4.158 s; saved-source reuse 5.520 s including checksum verification. Topology compressed to 3,566,941 bytes (1.263 s request) from approximately 22.95 MB raw; paused initial snapshot compressed to 83,905 bytes (0.154 s request). Replaying to 07:44:55 took 16.154 s in the sampled run. Long seeks are synchronous and may temporarily make the observer report stale/unavailable state; reconnection is automatic.

## Explicit architectural limits and safest follow-up

1. **Individual vehicles/lane conflicts:** the live GraphStore stores aggregate edge counts/speeds, and the SUMO adapter only exports/runs batches. Flow markers therefore are representative samples, with no invented IDs or trajectories. A future live SUMO telemetry adapter must map vehicle IDs, lanes and movements into canonical state before individual inspection or lane-level safety claims are possible.
2. **Complex OSM buildings:** the lightweight importer handles points and simple ways, not multipolygon relation/inner-ring assembly. Preserve source IDs and introduce a relation-aware ring importer before claiming complete complex footprints.
3. **Arbitrary operator-edit replay:** fixed startup configuration, scheduled events and playback speed/seek are verified deterministic. Legacy world-mutation undo/redo is not a fully time-indexed event journal. Integrate command events into checkpoints before promising exact historical replay of arbitrary day/module/manual world edits. Those edits are not exposed in the observer.
4. **Event archive:** history is intentionally a rolling 2,000-execution observation window with an all-time counter; future signal inspection shows each controller’s next pending transition. A full durable execution archive would need a separate append-only storage/pagination path.
5. **Performance scope:** browser measurements are local Chrome samples with the selected ~5,400-node district. The 10,000-controller heap is stress-tested separately. This is not evidence of production-scale capacity across every map/device. Source geography and source bytes constrain seed diversity.
6. **PDF text:** the local Inter subset covers Latin names/diacritics. Supporting all world scripts requires broader embedded fonts and script shaping; the report is not a tagged accessibility PDF.
