# GitHub Issue Resolution Context

## Repository Overview

- Repository: `CSC210-Monsoon2026/group-08-public-bus-route-planner`
- Checkout: `/Users/varun/Library/CloudStorage/OneDrive-Personal/SUMO_Sandbox/dstns`
- Remote default branch: `main`
- Initial working branch: `dstns` (tracking `origin/dstns`, initially up to date)
- Task: inventory, investigate, and resolve every actionable open GitHub issue with production-quality validation and GitHub documentation.

## Initial Repository State

- Initial commit history head: `257257a Bug Fixes & UX Changes`; previous commit `179d79b Initial Commit`.
- `git fetch --all --prune` completed successfully on the initial branch.
- The worktree was already dirty before this run. Existing modifications are confined to clangd index artifacts under `.cache/clangd/index/` and generated SUMO artifacts under `data/sumo_run/` (`network.edg.xml`, `network.net.xml`, `network.nod.xml`, `sandbox.add.xml`, and `sandbox.rou.xml`). These changes are treated as user-owned and will not be overwritten, reverted, or staged.
- No pre-existing `context/issue_context.md` was present; this journal was created before code changes.

## Repository Architecture

- CMake/C++20 core library (`dstns_core`) owns deterministic RNG, OSM ingestion, canonical graph/state, scenario compilation, simulation/playback, logging, REST/SSE API, and SUMO export/bridge.
- Executables include the HTTP server plus scenario export, road-index, replay-verification, and benchmark tools.
- The operator UI is a React/TypeScript/Vite application under `ui-engine/`, served through its Node overlay or the C++ runtime deployment path.
- Native verification is divided into unit, property, replay, and performance CTest targets. Additional API, SUMO, and UI suites live under `tests/` and `ui-engine/tests/`.
- There is no committed CI workflow under `.github/workflows/`; GitHub-side validation therefore depends on PR checks configured externally, if any.
- `origin/main` is the GitHub default branch but contains the course-level repository and does not contain this DSTNS implementation. The DSTNS code and all eight issues apply to the long-lived `dstns` branch. Fix PRs must therefore target `dstns`; issue closure will be manually verified after merge because GitHub closing keywords only auto-close reliably when merged into the default branch.

## Issue Inventory

All open issues were retrieved with structured output and individually inspected, including comments and linked PR references. No open or historical pull requests currently exist.

| Issue | Category / severity | Subsystem | Complexity | Dependencies / relationship | Initial assessment |
|---|---|---|---|---|---|
| #1 One-way restrictions not enforced | Correctness, high | OSM graph, routing, trip planning, transit API, SUMO export | Medium | Dynamic-route property coverage belongs with #7 | Actionable; provenance exists but traversal/export behavior must be traced before choosing representation. |
| #2 Checkpointing stops after unaligned step | Correctness/performance, high | Playback stepping and seek | Medium | Closely coupled to #3 and replay coverage in #7 | Actionable; issue comment supplies the missing unaligned-time reproducer. |
| #3 Seek breaks news-id reproducibility | Determinism/API, high | Checkpoints, replay, incremental news | Medium | Same replay/checkpoint root area as #2; tests required by #7 | Actionable; checkpoint state is incomplete. Event-id behavior requires separate semantic analysis because manual controls are journaled differently from deterministic news. |
| #4 `map_hash` hashes only 10 KB | Determinism, medium | OSM loader, manifest/scenario hashes | Low | OSM replay test in #7 can add downstream coverage | Actionable; full input must be hashed and collision regression added. |
| #5 JSON field errors return 500 | API contract, medium | HTTP exception mapping and logs | Low/medium | API smoke suite is natural regression layer | Actionable; nlohmann exception hierarchy confirms the report. |
| #6 Scenario compiler iterator and signal phases | Safety/correctness, medium | Bus-stop placement, signal planning | Medium | Property tests in #7 can enforce phase invariants | Actionable; both defects share one compiler file but need separate regressions. |
| #7 Named suites overclaim coverage | Test credibility, high | Performance, replay, property tests, verification tool/docs | Medium/high | Directly protects #1-#3 and #6; should be completed after those runtime fixes | Actionable; current test names/documentation exceed what the assertions demonstrate. |
| #8 Component docs describe nonexistent modules/order | Documentation/API integration risk, medium | `docs/components/` architecture map | Medium | Must reflect final implementation after all code work | Actionable; documentation should describe concrete classes/functions in the single `dstns` namespace, not invented namespaces or indexes. |

No duplicates, invalid reports, or already-fixed issues were found. Processing order: #1; #2/#3; #4; #5; #6; #7; #8, with related regression coverage landed alongside each root-cause fix and the broader suite-strengthening completed afterward.

## Global Dependencies and Relationships

- #2 and #3 both arise because checkpoints do not fully encode replay state; they should share one branch/PR and one adversarial replay review while retaining issue-specific tests and documentation.
- #7 is downstream of #1-#3 and #6 because its missing behavioral assertions allowed those regressions to survive. Runtime fixes will add focused tests; #7 will then make each named suite truthful at its intended layer.
- #8 is intentionally last so component documentation describes the final implementation rather than an intermediate state.
- #1 affects both in-process routing and exported SUMO topology. Merely filtering the A* loop may leave SUMO and API-contiguity semantics inconsistent, so all consumers of `synthetic_reverse` and adjacency must be inspected.

## Current Work

Repository architecture and all issue reports have been reviewed. Untouched baseline completed. Issue #1 is implemented on `fix/issue-1-one-way-routing` and undergoing layered validation.

### Issue #1 — One-way restrictions are recorded but never enforced in routing

#### Problem and Reproduction

The loader creates a normal forward edge and a `synthetic_reverse` topology twin for OSM one-way segments. Before this change, A*, precompiled trips, transit route validation, hotspots, bus-stop lane selection, runtime traffic, and SUMO export all treated both directions as drivable. `tests/fixtures/roads.osm.xml` provides a direct reproducer: node 101 to 102 is allowed, while 102 to 101 must use a legal multi-edge detour.

#### Root Cause

`synthetic_reverse` was modeled and serialized only as provenance. There was no centralized source-direction predicate, so behavioral consumers independently treated every canonical edge as traversable. Existing tests asserted that the flag existed but never asserted its effect.

#### Impact Analysis and Plan

Inspected `GraphStore::outgoing`, `RoutePlanner::route`, `ScenarioCompiler::plan_trips`, bus-stop placement, hotspot planning, `SimulationEngine::validate_transit_route`, edge physics, SUMO export/bridge, API serializers, UI bus rendering, and reverse-twin documentation. Reverse twins remain necessary for stable topology and visualization; removing them would violate the existing reciprocity contract and renumber edges. The compatible fix is to retain them as topology-only edges and apply one shared `is_source_direction_allowed` predicate at every behavioral boundary.

#### Implementation

- Added a central source-direction predicate in the data model.
- A* and therefore precompiled demand routes skip forbidden reverse twins.
- Transit route validation rejects a node step that exists only as a forbidden reverse twin.
- Bus stops and hotspots select only traversable directions.
- The coverage-repair loop now carries a validated traversable outgoing-edge iterator instead of dereferencing an unchecked lookup. This also resolves the iterator-safety half of issue #6 as a necessary dependency of correct one-way bus-stop placement; issue #6 remains open for its independent signal-cycle defect.
- Runtime physics keeps topology-only edges at zero traffic/capacity/speed metrics while retaining environmental state used by the map.
- SUMO export omits topology-only edges, preserving OSM directionality in the microscopic network.
- Removed fabricated one-way provenance from the source-less synthetic grid. This was discovered when the first targeted run caused the existing road-closure detour assertion to fail: enforcing `synthetic_reverse` exposed that the fixture had arbitrarily marked every eleventh segment as one-way. The grid is now consistently bidirectional; only OSM source data creates forbidden directions.
- Updated routing, OSM-loader, and SUMO component behavior documentation.

#### Tests Added or Modified

Unit coverage now proves forward one-way routing, legal reverse detouring, trip/bus-stop/hotspot exclusion, and SUMO edge omission. Property coverage asserts every planned-trip and bus-stop edge is source-direction traversable. API smoke coverage locates an actual topology-only reverse edge, rejects its transit dispatch, and accepts the legal twin direction.

#### Security / Compatibility / Performance Review

No new input, filesystem, privilege, or subprocess surface was introduced. Canonical edge IDs, reverse twins, hashes, API topology, and UI geometry remain backward-compatible. Routing performs one constant-time flag check per relaxed edge; scenario preprocessing filters rather than adds work.

#### Validation Results

First targeted build passed compilation, but the unit test failed at the pre-existing `routing around closure` assertion because the synthetic grid's fabricated one-way flags became behavioral. Root cause was confirmed and corrected as described above. The second targeted native and SUMO run passed. The first expanded API run correctly returned HTTP 400 for the forbidden transit step while the new test had expected 200; inspection confirmed `src/api.cpp` intentionally maps `{ok:false}` results to 400. The assertion was corrected without changing production behavior. Adversarial inspection also found topology-only edges retained nonzero initial capacity/speed until the first physics step; `GraphStore` initialization/reset now keeps them at zero from scenario start.

Final post-review validation: Release build PASS; CTest 4/4 PASS; API smoke 72 assertions PASS; SUMO integration PASS; replay verification PASS; benchmark PASS (10.086 microseconds/route in this run); UI Vitest 7/7 PASS; TypeScript/Vite build PASS; `git diff --check` PASS. Docker remains environmentally unavailable as recorded in the baseline.

#### Git Operations

Branch: `fix/issue-1-one-way-routing`. Functional commit: `5a1a6b4`; journal commit: `c0b6be5`; merge commit: `3593ef9`. PR #9 was merged into `dstns` with no configured checks (`statusCheckRollup` empty). A detailed resolution comment was posted, and issue #1 was manually closed as completed after merge because the PR base is not GitHub's default branch.

#### Final Status

Resolved, merged, documented, and CLOSED.

### Issues #2 and #3 — Checkpoint continuity and news-ID replay

#### Problem and Reproduction

- #2: after stepping to an unaligned time such as 137 seconds, fixed 60-second steps skip every subsequent 900-second checkpoint boundary. A forward seek to 3001 seconds should leave checkpoints at 0, 900, 1800, and 2700.
- #3: a backward seek to a non-checkpoint time truncates news but leaves `next_news_id_` at its later high-water mark. Replaying across the deterministic 11:20 incident at 40,800 seconds therefore changes `event_stack[].news_id`.

#### Root Cause

`step_to` captured only on exact modulo equality without shortening steps at boundaries. `Checkpoint` stored dynamic vectors and news length but not the news-ID cursor. `restore_to` also retained future checkpoints after truncating their corresponding news, creating an ordered-cache/history inconsistency. Forward seeks always restored even when no rewind was required.

#### Impact Analysis and Decisions

Inspected live wall-clock advancement, public seek, start/prepare initialization, graph state, deterministic event generation, incremental news polling, manual weather/surge/transit event IDs, control journals, checkpoint ordering, snapshot serialization, replay tests, verifier tooling, and playback docs. `next_event_id_` is intentionally not rewound: manual events are neither regenerated nor truncated on seek, and reusing their identifiers would create collisions. News events are deterministic replay output, so their cursor belongs in a checkpoint.

#### Implementation

- Shorten each physics step to the next 900-second boundary.
- Centralize ordered checkpoint insert/replace and use it for prepared/started scenarios.
- Store and restore `next_news_id_` with checkpoint state.
- Discard invalid future checkpoints after rewind.
- Advance forward seeks from current state; restore only for backward seeks.
- Expose checkpoint count in status diagnostics.
- Correct playback documentation from 300 to the implemented 900 seconds and document cursor/cache semantics.

#### Tests Added or Modified

Unit regression advances through 137 then 3001 seconds and asserts four checkpoints, then compares full snapshot data at 40,830 seconds before and after a forward-to-45,000/backward replay. The selected time forces deterministic news regeneration after the 40,500 checkpoint.

#### Validation Results

Targeted Release build and unit regression: PASS. The first API run timed out once during the pre-existing double-start request; an immediate isolated rerun passed, and the full post-review rerun also passed, so this is recorded as a transient test-process observation rather than a reproduced product defect.

Final post-review validation: CTest 4/4 PASS; API smoke 75 assertions PASS; SUMO integration PASS; replay verifier PASS; UI Vitest 7/7 PASS; TypeScript/Vite build PASS; `git diff --check` PASS. Docker remains environmentally unavailable.

#### Security / Compatibility / Performance Review

No external-input or privilege surface changed. Status gains an additive `checkpoint_count` diagnostic and the TypeScript contract/docs were updated. Boundary splitting adds at most one short step at each crossed 900-second boundary. Checkpoint insert/replace is linear in at most 97 daily checkpoints; this bounded cost prevents unordered duplicates and stale future state. Forward seek avoids unnecessary resets. Manual event IDs remain monotonic and collision-free.

#### Git Operations

Branch: `fix/issues-2-3-replay-checkpoints`. Commit, push, PR, checks, merge, issue comments, and closure are pending.

## Baseline Validation

Executed before issue code changes on 2026-09-07:

- Release CMake configure/build: PASS; all core, server, tool, and test targets built. CMake emitted pre-existing developer warnings that `FetchContent_Declare` does not specify `DOWNLOAD_EXTRACT_TIMESTAMP` for json and httplib.
- CTest: PASS, 4/4 targets (`unit`, `property`, `replay`, `performance`) in 3.78 s. These green results do not invalidate issue #7: the reported problem is insufficient assertions, not current failures.
- API smoke: PASS, 68 assertions.
- UI Vitest: PASS, 7 tests.
- UI TypeScript/Vite production build: PASS.
- SUMO integration smoke: PASS (`netconvert`/headless SUMO path).
- Replay verification and benchmark tools: PASS as currently implemented; issue #7 correctly notes their replay evidence is weaker than their names imply.
- Docker/Compose runtime gate: UNRUN/BLOCKED because Docker Desktop daemon is unavailable (`Cannot connect to the Docker daemon at .../.docker/run/docker.sock`). The client and Compose plugin are installed. This is an environmental limitation, not recorded as a repository defect.
- No standalone lint/formatter/static-analysis configuration exists beyond C++ warning flags with test targets using `-Werror`, TypeScript compilation, and the build/test gates above.

## Cross-Issue Findings

None yet.

## Additional Problems Discovered

None beyond the pre-existing dirty generated/cache files noted above.

## Final Repository Validation

Not yet run.

## Remaining Issues

Pending inventory.

## Final Status

In progress.
