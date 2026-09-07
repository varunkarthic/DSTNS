# DSTNS Testing Context

## 1. Test Architecture & Automated Suites

### CTest Executables (in `build/`)
1. **`dstns_unit_tests` (`tests/unit/test_main.cpp`)**:
   - Primitives: Seed128 parse/hex round-trip, SHA-256 vector, Philox RNG repeatability and domain isolation, Wendland $C^2$ spatial kernel, temporal beta kernel.
   - **Sub-Seed Derivation & Avalanche Tests (NEW)**:
     - `DeterministicSeeding_SubSeedAvalanche`: Asserts that flipping 1 bit in master seed causes $\ge 40$ bit flips in derived sub-seeds.
     - `DeterministicSeeding_DomainSeparation`: Asserts independent hashes across `"map"`, `"dws"`, `"traffic"`, `"incidents"`, `"events"`, `"scenario"`.
   - **Incident Subsystem Tests (NEW)**:
     - `IncidentSubsystem_MinimumCount`: Asserts $\ge 4$ incidents generated across multiple distinct seeds.
     - `IncidentSubsystem_TemporalDistribution`: Asserts incidents populate early ($[3600, 21600)$), midday ($[21600, 50400)$), and late ($[50400, 75600)$) slots.
     - `IncidentSubsystem_EdgeResolution`: Asserts edge closure and speed attenuation during active phase and clean restoration upon resolution.
   - **Simulation Reset Cleanliness Test (NEW)**:
     - `SimulationReset_CleanPurge`: Runs Sim A, records state, executes `reset()`, runs Sim B with manual weather and bus dispatches, executes `reset()`, and re-runs Sim A, asserting identical hashes and zero residual state leakage.
   - Scenario & Graph: Compile replay hash, reverse twin reciprocity, bus stops, DWS event spacing, OSM filtering, A* routing, zero-distance self route, routing around closed edge.
   - Engine: Start, pause, seek across checkpoint boundaries, tick rate, undo/redo, stop, reset.

2. **`dstns_property_invariants` (`tests/property/property_tests.cpp`)**:
   - Invariant 1: Edge endpoints exist, lengths/speeds/capacities $>0$, reverse twin reciprocity.
   - Invariant 2: Bus stops on valid, source-direction traversable edges within edge length.
   - Invariant 3: Planned trips exclude forbidden reverse twin directions.
   - Invariant 4: Signal plan phase durations sum $\le$ cycle.
   - Invariant 5: Weather events have valid spatial/temporal bounds, intensity in $[0, 1]$.
   - Invariant 6: Routing excludes dynamically closed edges.
   - Invariant 7: Dynamic simulation percentages, rainfall, and flood bounded in $[0, 1]$.
   - **Invariant 8: Incident Integrity (NEW)**:
     - Target edges exist and are $< |E|$.
     - Node anchors exist and are $< |V|$.
     - Start and end times satisfy $t_{\text{start}} < t_{\text{end}}$ within virtual day.
     - Speed and capacity multipliers bounded in $[0, 1]$.

3. **`dstns_replay_reproducibility` (`tests/replay/replay_tests.cpp`)**:
   - Dual compilation and fixed-time engine snapshot equality across independent runtime instances.

4. **`dstns_performance_smoke` (`tests/performance/perf_tests.cpp`)**:
   - Micro-performance check: Scenario compilation time and 2,500 A* routing queries (mean route time ceiling $< 500\,\mu\text{s}$).

---

## 2. Integration & API Verification

1. **`tests/api/api_smoke.py`**:
   - 82 assertions covering:
     - Health and status endpoints.
     - Playback lifecycle: prepare, start, pause, resume, seek, stop, reset.
     - Topology views, dynamic snapshot, node/edge paging, entity catalogs.
     - **Incident Endpoints (NEW)**:
       - Querying `GET /api/v1/view/incidents` and verifying $\ge 4$ incidents.
       - Validating `snapshot.data.active_incidents` schema.
     - Tick rate control, day override, manual weather injection, edge overrides.
     - SUMO export/simulate and graceful termination.
2. **`tests/integration/sumo_smoke.sh`**:
   - Scenario export to XML, `netconvert` compilation, and headless SUMO simulation step.
3. **`ui-engine` Build**:
   - `npm --prefix ui-engine run build` runs `tsc -b` and `vite build`.

---

## 3. Execution & Validation Log

| Test Suite | Command | Result | Details |
|---|---|---|---|
| CTest Full Suite | `ctest --test-dir build --output-on-failure` | 4/4 Passed (5.80s) | `dstns_unit_tests`, `dstns_property_invariants`, `dstns_replay_reproducibility`, `dstns_performance_smoke` |
| API Smoke Test | `python3 tests/api/api_smoke.py --server build/dstns_server` | Passed | 82/82 assertions passed |
| SUMO Smoke Test | `bash tests/integration/sumo_smoke.sh` | Passed | Exported road network compiled by netconvert and stepped in SUMO |
| UI Build | `npm --prefix ui-engine run build` | Passed (142ms) | Zero TypeScript compiler or bundler warnings |
| Terminology Audit | `grep_search "Dynamic Weather"` | Passed | Zero unauthorized occurrences; canonical expansion strictly DWS = Deterministic Weather Simulation |

---

## 4. Final Validation Status
- **Unit Tests**: 100% PASS
- **Property Invariants**: 100% PASS
- **Replay Reproducibility**: 100% PASS
- **Performance Smoke**: 100% PASS
- **API Smoke**: 100% PASS
- **SUMO Integration**: 100% PASS
- **UI Compilation**: 100% PASS
