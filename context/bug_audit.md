# DSTNS Comprehensive Bug Audit

## BUG-001: Incorrect DWS Terminology ("Dynamic Weather" vs "Deterministic Weather Simulation")
- **Severity**: High (Violation of project invariant & canonical terminology)
- **Component**: Documentation, UI Engine, API descriptions, Model comments
- **Status**: VERIFIED
- **Evidence**:
  - `ui-engine/src/App.tsx` line 992: `title="Dynamic Weather System scheduled storm cells"`
  - `README.md` lines 5, 13, 141: "dynamic weather cells (DWS)", "Dynamic Weather Injection"
  - `docs/api/playback-api.md`, `news-api.md`, `control-api.md`, `MATHEMATICAL_MODEL.md`, `context/12_GLOSSARY.md`, `02_SYSTEM_ARCHITECTURE.md`, `01_MATHEMATICAL_FOUNDATION.md` all expanded DWS as "Dynamic Weather Simulation" or "Dynamic Weather System".
- **Root Cause**: Stale naming introduced in legacy drafts before formalization of the 128-bit counter-based determinism standard.
- **Affected Components**: README, `/docs/` guides, `/context/` references, `ui-engine/src/App.tsx`.
- **Fix**: Replaced all occurrences of "Dynamic Weather" with canonical "Deterministic Weather Simulation" (DWS) across UI, README, documentation, and context files.
- **Tests**: Full text search across repository verifying zero erroneous instances of "Dynamic Weather".
- **Regression Risk**: None; API endpoints (`/api/v1/control/events/weather`) and config keys (`dws`) preserved.

---

## BUG-002: Seed Coupling & Lack of Domain Separation
- **Severity**: Critical (Breaks subsystem isolation & determinism)
- **Component**: `dstns::DeterministicRng`, `dstns::ScenarioCompiler`
- **Status**: VERIFIED
- **Evidence**:
  - `DeterministicRng` used a single master seed across all domains with simple XOR keys.
  - Adding or modifying incident generation, trip planning, or weather draws altered random draws in unrelated subsystems.
  - Small seed changes produced adjacent coordinates rather than distinct metropolitan networks.
- **Root Cause**: Missing cryptographic domain-separated sub-seed derivation function.
- **Affected Components**: `rng.hpp`, `rng.cpp`, `scenario.cpp`, `osm.cpp`.
- **Fix**: Implemented `Seed128::derive(domain)` using SHA-256 to produce domain-isolated sub-seeds (`map`, `dws`, `traffic`, `incidents`, `events`, `scenario`). Added 16-city worldwide metropolitan transport catalog.
- **Tests**: Verified by `DeterministicSeeding_SubSeedAvalanche` (asserting $\ge 40$ bit flips on 1-bit change) and `DeterministicSeeding_DomainSeparation` in `tests/unit/test_main.cpp`.
- **Regression Risk**: None.

---

## BUG-003: Incident Stack Broken & Zero Incidents During Normal Simulation Runs
- **Severity**: Critical (Subsystem failure / Non-functional feature)
- **Component**: `dstns::SimulationEngine`, `dstns::ScenarioCompiler`, `ui-engine/src/App.tsx`
- **Status**: VERIFIED
- **Evidence**:
  - Incidents in `engine.cpp` were implemented as 7 static text strings in `notify_time` scheduled at 07:15 (26,100s)+.
  - In normal simulations (duration 60s to 3600s), virtual time never reached 26,100s, so zero incidents ever occurred.
  - Hardcoded news had no physical effect on road edges (no edge closure, no capacity/speed degradation).
  - Snapshot `active_incidents` was an ad-hoc filter on edges with `closed || congestion >= 0.70`, lacking metadata.
- **Root Cause**: Incomplete architectural implementation of the Incident subsystem.
- **Affected Components**: `model.hpp`, `scenario.hpp`, `scenario.cpp`, `engine.hpp`, `engine.cpp`, `api.cpp`, `App.tsx`.
- **Fix**:
  1. Added first-class `Incident` model (`id`, `type`, `lifecycle`, `target_edge`, `from_node`, `to_node`, `start_time_s`, `end_time_s`, `speed_multiplier`, `capacity_multiplier`, `closes_road`, `description`).
  2. Implemented `ScenarioCompiler::plan_incidents` generating $\ge 4$ incidents per simulation, deterministically scheduled across early, middle, and late slots on traversable edges.
  3. Applied real simulation effects in `physics_step` (edge closure, speed/capacity reduction) with conservative overlapping composition.
  4. Exposed rich incident objects in `snapshot.active_incidents` and registered `GET /api/v1/view/incidents`.
  5. Updated UI to render real active/completed incidents directly.
- **Tests**: Verified by `IncidentSubsystem_MinimumCount`, `IncidentSubsystem_TemporalDistribution`, `IncidentSubsystem_EdgeResolution` in `test_main.cpp`, `IncidentInvariants` in `property_tests.cpp`, and `api_smoke.py`.
- **Regression Risk**: None.

---

## BUG-004: Event Stack Broken & Inconsistent Catalog
- **Severity**: Medium/High (API contract & event tracking defect)
- **Component**: `dstns::SimulationEngine`, `dstns::ApiServer`
- **Status**: VERIFIED
- **Evidence**:
  - Snapshot event stack took raw news items regardless of category or lifecycle.
  - Simultaneous events lacked deterministic tie-breaking.
- **Root Cause**: Event stack was aliased to general news list without lifecycle tracking.
- **Affected Components**: `engine.hpp`, `engine.cpp`, `api.cpp`, `model.hpp`.
- **Fix**:
  1. Enforced deterministic tie-breaking `(virtual_s, priority, event_id)`.
  2. Maintained structured active incident events and registered catalog endpoint `"incidents"`.
- **Tests**: Verified via `api_smoke.py` and `test_main.cpp`.
- **Regression Risk**: None.

---

## BUG-005: Simulation Reset State Leakage
- **Severity**: High (State isolation failure between runs)
- **Component**: `dstns::SimulationEngine::reset()`
- **Status**: VERIFIED
- **Evidence**:
  - `reset()` failed to clear:
    - `manual_weather_`
    - `active_surges_`
    - `signal_overrides_`
    - `active_transit_buses_`
    - `signal_by_node_`
    - Did not reset `next_command_id_`, `next_news_id_`, `next_event_id_`.
- **Root Cause**: Omission of runtime collections in reset routine.
- **Affected Components**: `engine.cpp`.
- **Fix**: `reset()` now completely clears all manual controls, storm cells, surges, signal overrides, transit buses, and resets all monotonic ID counters to pristine baseline.
- **Tests**: Verified by `SimulationReset_CleanPurge` in `tests/unit/test_main.cpp`.
- **Regression Risk**: None.

---

## BUG-006: Nondeterminism in API Weather Control Endpoint
- **Severity**: Medium (Determinism violation)
- **Component**: `dstns::ApiServer`
- **Status**: VERIFIED
- **Evidence**:
  - `src/api.cpp` line 296: `const double default_rad = 100.0 + static_cast<double>(std::rand() % 501);`
- **Root Cause**: Uncontrolled use of `std::rand()` in an API handler of a deterministic simulator.
- **Affected Components**: `src/api.cpp`.
- **Fix**: Replaced `std::rand()` with a deterministic default radius of 350.0m.
- **Tests**: Validated via `tests/api/api_smoke.py`.
- **Regression Risk**: None.

---

## BUG-007: CRFG Map Node Scaling Clamped to Small Fragments
- **Severity**: Medium (Network scale restriction)
- **Component**: `dstns::OsmRoadLoader`
- **Status**: VERIFIED
- **Evidence**:
  - `src/osm.cpp` lines 258-263 clamped target nodes to `180 + size_variance` (180 to 700 nodes), ignoring larger requests.
- **Root Cause**: Hardcoded upper limit on CRFG size variance.
- **Affected Components**: `src/osm.cpp`.
- **Fix**: Permitted target node expansion up to `max_nodes` while respecting minimum bounds.
- **Tests**: Verified via `sumo_smoke.sh` and CTest suite.
- **Regression Risk**: None.

---

## BUG-008: Hardcoded Machine-Specific Path in API Server Static File Resolver
- **Severity**: Low (Portability issue)
- **Component**: `dstns::ApiServer::routes()`
- **Status**: VERIFIED
- **Evidence**:
  - `src/api.cpp` line 100: hardcoded absolute path `/Users/varun/Library/CloudStorage/OneDrive-Personal/SUMO_Sandbox/dstns/ui-engine/dist`.
- **Root Cause**: Debug path committed during local testing.
- **Affected Components**: `src/api.cpp`.
- **Fix**: Removed absolute path, using relative directory checks (`ui-engine/dist`, `../ui-engine/dist`, `dist`, `/app/ui-engine/dist`).
- **Tests**: Verified server launches and serves static assets correctly.
- **Regression Risk**: None.
