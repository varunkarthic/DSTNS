# v3 modular engine migration plan

Status: **plan, release 0**. The engine behaviour does not change in release 0.

Baseline: `v3` at `d29a2f6` (source) / `b828aa6` (graph). Engine `3.0.0`, observer `3.1.0`, API contract `1.4`,
map selection `urban-crfg-v3`, algorithms `DSTNS/1`.

## 1. Goal

Build a new, modular engine beside the current engine. Move one responsibility at a time from the current engine
into the new modules. The operator selects the engine in the launcher. The current engine stays the default until
the new engine gives identical hashes for every golden fixture. We do not replace the engine in one operation.

## 2. How the two engines live together

| Setting (launcher) | Values | Default | Effect |
|---|---|---|---|
| `engine.implementation` | `legacy`, `modular` | `legacy` | Which code path prepares worlds and steps physics. Sent to the server in the start request |
| `map.selection_policy` | `urban-crfg-v3`, `urban-geo-v1` | `urban-crfg-v3` | Which city-selection policy resolves the seed |
| `map.selection_mode` | `global`, `countries`, `cities`, `fixed_city` | `global` | Only for `urban-geo-v1` |
| `map.countries`, `map.cities` | canonical IDs (ISO 3166-1 alpha-2, city slug) | empty | Only for `urban-geo-v1` |
| `ui.label_language` | `original`, `en`, other OSM language codes | `original` | Display only, in WebKit. No effect on results |

Rules:

- `legacy` is frozen code. We fix only defects in it, each as a separately versioned patch.
- Each release moves one responsibility into a `modular` module. A parity test runs the same golden inputs through
  both engines and requires identical `map_hash`, `graph_hash`, `event_hash`, `scenario_hash` and snapshots.
- A release that cannot reach parity does not ship. A deliberate behaviour change gets a new policy or algorithm ID.
- When every responsibility has moved and parity holds, `modular` becomes the default (a MINOR release).
  We remove `legacy` only with operator approval (a MAJOR decision).

## 3. Dependency map (current)

```text
LaunchKit config.rs ──start request──> Fabric support.cpp (parse ScenarioConfig, check selection version)
                                            │
                                            v
SimulationEngine (engine.cpp, 3049 lines) ─ lifecycle, clock, physics_step, checkpoints, commands,
   │                                         undo/redo, world job, views, news, SUMO
   ├─> ScenarioCompiler::compile (scenario.cpp) ── validate config
   │      ├─> select_map_location (geo.cpp)          ← also called by NextWorld, engine failed_city
   │      ├─> acquire_map_tile (osm_fetch.cpp)
   │      ├─> OsmRoadLoader (osm.cpp)
   │      └─> signals, stops, hotspots, trips, weather, incidents, hashes
   ├─> GraphStore / RoutePlanner (graph.cpp)
   ├─> EventRuntime (events.cpp)
   └─> NextWorld (next_world.cpp) ── next-world.json ←── LaunchKit prepared_seed()
```

Callers of `select_map_location` (graph, confirmed in source): `ScenarioCompiler::compile`, `NextWorld::installed`,
`NextWorld::take`, `seed_avoiding_failed_city`, `SimulationEngine::failed_city`, and two tests.
The literal `urban-crfg-v3` is checked in `scenario.cpp:42`, `Fabric/src/support.cpp:299`, `LaunchKit/src/config.rs`,
`LaunchKit/src/seeds.rs` and `LaunchKit/src/state.rs` (launch codes).

## 4. Proposed interfaces (new module `Core/src/world/`)

```cpp
struct SelectionPolicy {            // value type, parsed and checked at the API boundary
    std::string id;                 // "urban-crfg-v3" | "urban-geo-v1"
    enum class Mode { Global, Countries, Cities, FixedCity } mode{Mode::Global};
    std::vector<std::string> countries, cities;   // canonical IDs, sorted, unique
    [[nodiscard]] std::string fingerprint() const;  // SHA-256 of the canonical form
};
MapLocation select_location(Seed128, const SelectionPolicy&, double extent_m);  // replaces select_map_location
struct RunSpec { Seed128 seed; ScenarioConfig config; SelectionPolicy policy; std::string engine; };
struct WorldManifest { MapLocation location; std::string policy_id, policy_fingerprint, map_hash, graph_hash,
                       event_hash, scenario_hash; };
```

`urban-crfg-v3` calls the current `select_map_location` unchanged. `urban-geo-v1` builds the eligible list in frozen
catalogue order, draws one index with `seed.derive("map.city.geo-v1")` and a bounded Philox draw, and draws the
anchor exactly as v3 does. An empty eligible list is an error. The catalogue gets a stable country code per city;
the order and the 181 entries do not change.

Later modules (one per release): `MapAcquirer` (cache + fetch), `DistrictBuilder` (OSM loader), `ScenarioPlanner`
(signals, demand, trips, weather, incidents, hashes), `WorldPreparation` (state machine below), `PhysicsStep`,
`CheckpointStore`. No plugin framework, no class hierarchy: free functions and value types where possible.

## 5. World preparation state machine (modular engine)

Internal states. The existing API values (`idle`, `generating`, `staged`, `ready`, `failed`) map from them.

| From | Event | To | Guard |
|---|---|---|---|
| Idle | regenerate, start | Selecting | no other job; not terminating |
| Selecting | location resolved | Acquiring | policy valid, eligible set not empty |
| Acquiring | map on disk | Building | generation unchanged |
| Building | scenario compiled | Validating | generation unchanged |
| Validating | hashes and limits pass | Staged / Installing | staged only if confirmation is required |
| Staged | commit | Installing | generation unchanged |
| Installing | installed | Ready | generation unchanged; installed under the engine lock |
| any active | failure | Failed | current world unchanged |
| any active | stop, reset, terminate | Cancelled | generation advanced; current world unchanged |
| Staged | discard | Discarded | — |
| Ready, Failed, Cancelled, Discarded | regenerate | Selecting | as Idle |

Every transition goes through one function. A test covers each allowed transition and each forbidden one
(for example Staged → Building, Installing after Cancelled). The engine lifecycle (`Lifecycle`) does not change.

## 6. Dynamic Fastboot changes

`next-world.json` gets `policy_id`, `policy_fingerprint`, `engine`, `source` and `version` beside the existing `seed`,
`city`, `extent_m`. A prepared seed is used only if all of them match the current request. A pointer without these
fields matches only the legacy policy, so old files stay safe. LaunchKit's `prepared_seed()` applies the same check.

## 7. Compatibility matrix

| Input | Legacy engine | Modular engine |
|---|---|---|
| seed only, `urban-crfg-v3` | same city, anchor and hashes as 3.0.0 | identical to legacy (parity test) |
| seed + `urban-geo-v1` policy | refused with `UNSUPPORTED_SELECTION_POLICY` | new result, identified by seed + policy fingerprint |
| saved seeds, launch codes | unchanged | unchanged (they carry `urban-crfg-v3`) |
| `/api/v1` clients | unchanged | unchanged; new optional fields only (API `1.5`) |
| `ui.label_language` | display only | display only |

## 8. Releases

| # | Scope | Versions | Evidence |
|---|---|---|---|
| 0 | Baseline, this plan, golden fixtures (seed → city/anchor; grid and bundled-OSM hashes) | none (tests and docs only) | baseline green; fixtures match current code |
| 1 | Launcher settings: `engine.implementation`, selection settings (only `urban-crfg-v3` accepted by the server yet) | launcher patch/minor | cargo tests; start request unchanged for defaults |
| 2 | `world/selection`: `SelectionPolicy`, legacy policy through the new interface; `engine` field accepted | engine 3.0.1 | golden selection fixtures unchanged |
| 3 | `urban-geo-v1` policy, validation, manifest fields, API 1.5 | engine 3.1.0, API 1.5 | determinism, empty/invalid sets, fingerprint stability |
| 4 | Label language fallback in WebKit | observer 3.2.0 | raw names intact; graph and replay hashes unchanged |
| 5 | World preparation and Fastboot guards (table above) | engine 3.1.x | cancel/restart/stale-pointer tests |
| 6 | Scenario compile split into modules, modular path | engine 3.1.x | parity: identical hashes, both engines |
| 7 | Physics step and checkpoint store, modular path | engine 3.1.x | byte-equal snapshots, both engines |
| 8+ | One measured optimisation per release (checkpoint memory first) | patch each | before/after benchmark table |
| last | `modular` becomes default; docs, Fabric, WebKit, end-to-end | engine 3.2.0 | full start, regenerate, observe, save, replay |

Each release: local `./scripts/test.sh` green, version and `CHANGELOG.md` in the same commits, push to the migration
branch, CI dispatched (`gh workflow run ci.yml --ref <branch>`) and green, graph rebuilt locally. Integration into
`v3` needs operator approval.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Two code paths drift | Parity test on every release; legacy frozen |
| A refactor changes floating-point order | Golden hashes; byte-equal snapshot comparison |
| Old `next-world.json` makes a filtered run reuse a legacy seed | Fingerprint check; missing fields mean legacy only |
| Fixed-city mode reveals the city from the seed only | The manifest always names the policy; a filtered world is never shown as seed-only |
| Graph workflow does not run on feature branches | Rebuild the graph locally before each push |

## 10. Rollback

Each release is a set of commits on the migration branch with a recorded green SHA. A failed release is reverted
with revert commits. At run time the operator sets `engine.implementation` back to `legacy`.
