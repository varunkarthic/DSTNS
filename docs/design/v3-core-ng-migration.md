# v3 core-ng migration plan

Status: **complete** (engine 3.10.0, core-ng 1.0.0, stable and the default). core-ng owns every computation of a run with results identical to core-legacy; core-legacy stays installed and selectable. Engine governance: [engine-governance.md](engine-governance.md).

Baseline: `v3` at `d29a2f6` (source) / `b828aa6` (graph). Engine `3.0.0`, observer `3.1.0`, API contract `1.4`,
map selection `urban-crfg-v3`, algorithms `DSTNS/1`.

## 1. Goal

Build a next-generation engine, **core-ng**, beside the current engine, **core-legacy**. Move one responsibility at a time from the current engine
into the new modules. The operator selects the engine in the launcher. The current engine stays the default until
the new engine gives identical hashes for every golden fixture. We do not replace the engine in one operation.

## 2. How the two engines live together

Work is on the branch `v3-core-ng`. Source layout:

| Path | Contents |
|---|---|
| `Core/core-legacy/{src,include}` | The current engine, moved unchanged in 3.0.1. Library `dstns_core` |
| `Core/core-ng/{src,include}` | The new engine. Headers under `dstns/core-ng/`, C++ namespace `dstns::core_ng`. Library `dstns_core_ng`, which may call `dstns_core` until each part has moved |
| `Core/server` | The process entry. It hosts both engines |


| Setting (launcher) | Values | Default | Effect |
|---|---|---|---|
| `engines.selected` | `core-legacy`, `core-ng` | `core-legacy` | Which code path prepares worlds and steps physics. Sent to the server in the start request |
| `map.selection_policy` | `urban-crfg-v3`, `urban-geo-v1` | `urban-crfg-v3` | Which city-selection policy resolves the seed |
| `map.selection_mode` | `global`, `countries`, `cities`, `fixed_city` | `global` | Only for `urban-geo-v1` |
| `map.countries`, `map.cities` | canonical IDs (ISO 3166-1 alpha-2, city slug) | empty | Only for `urban-geo-v1` |
| `ui.label_language` | `original`, `en`, other OSM language codes | `original` | Display only, in WebKit. No effect on results |

Rules:

- `core-legacy` is frozen code. We fix only defects in it, each as a separately versioned patch.
- Each release moves one responsibility into `core-ng`. A parity test runs the same golden inputs through
  both engines and requires identical `map_hash`, `graph_hash`, `event_hash`, `scenario_hash` and snapshots.
- A release that cannot reach parity does not ship. A deliberate behaviour change gets a new policy or algorithm ID.
- When every responsibility has moved and parity holds, `core-ng` becomes the default (a MINOR release).
  We remove `core-legacy` only with operator approval (a MAJOR decision).

## 3. Dependency map (current, engine 3.13)

```text
LaunchKit config.rs ──start request──> Fabric support.cpp (parse ScenarioConfig) ── gate.cpp (engines.json policy)
                                            │
                                            v
Core/common   SimulationEngine (engine.cpp): lifecycle, clock, commands, world job, views, news, SUMO bridge;
              no engine of its own. It calls the registered EngineHooks: select, validate, describe, compile,
              step, capture, rewind. Also GraphStore, EventRuntime, NextWorld, OSM loading and fetching, geo
              (city_catalog: 181 cities; world_catalog: 379), weather helpers.
Core/core-ng  selection (urban-crfg-v3, urban-geo-v1, urban-geo-v2), compile (network, plans), physics, timeline,
              lifecycle and world-job tables. Links Core/common only (dstns_core_ng_alone).
Core/core-legacy  ScenarioCompiler, physics step and checkpoints, its hooks. Frozen; off by default.
Core/engines  install_engines(): registers both, and core-ng's guards.
```

The literal `urban-crfg-v3` is checked in `Fabric/src/support.cpp` (the default), `LaunchKit/src/config.rs`,
`LaunchKit/src/seeds.rs` and `LaunchKit/src/state.rs` (launch codes).

## 4. Proposed interfaces (`Core/core-ng`, namespace `dstns::core_ng`)

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

## 5. World preparation state machine (core-ng)

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

| Input | core-legacy | core-ng |
|---|---|---|
| seed only, `urban-crfg-v3` | same city, anchor and hashes as 3.0.0 | identical to legacy (parity test) |
| seed + `urban-geo-v1` policy | refused with `UNSUPPORTED_SELECTION_POLICY` | new result, identified by seed + policy fingerprint |
| saved seeds, launch codes | unchanged | unchanged (they carry `urban-crfg-v3`) |
| `/api/v1` clients | unchanged | unchanged; new optional fields only (API `1.5`) |
| `ui.label_language` | display only | display only |

## 8. Releases

| # | Scope | Versions | Evidence |
|---|---|---|---|
| 0 | Baseline, this plan, golden fixtures (seed → city/anchor; grid and bundled-OSM hashes and snapshots) | ships in 3.0.1 | baseline green; fixtures match engine 3.0.0 |
| 1 | Move the engine to `Core/core-legacy` | engine 3.0.1 | golden fixtures unchanged; full suite green |
| 2 | `Core/core-ng` library; `engine` in the start request, status, manifest and system info; core-ng map selection through `SelectionPolicy`, legacy policy only. The launcher setting waits for the integration phase | engine 3.1.0, API 1.5 | golden fixtures pass on both engines |
| 3 | `urban-geo-v1` policy, validation, manifest fields. The launcher settings wait for the integration phase | engine 3.2.0, API 1.6 | determinism, empty/invalid sets, fingerprint stability |
| 4 | Label language fallback in WebKit; `ui.label_language` | observer 3.2.0 | raw names intact; graph and replay hashes unchanged |
| 5 | World preparation and Fastboot guards (table above), core-ng | engine patch | cancel/restart/stale-pointer tests |
| 6 | Scenario compile in core-ng: `compile.cpp` orders the modules in `network.cpp` and `plans.cpp`, ported from core-legacy with every expression unchanged | engine 3.3.2 | parity: identical hashes and snapshots, both engines, macOS and Linux |
| 7 | Physics step (3.7.0) and checkpoint store (3.8.0) in core-ng, each moved out of `engine.cpp` behaviour-preserving first, then copied into core-ng with every expression unchanged | engine 3.7.0, 3.8.0 | `dstns_golden` snapshots and `dstns_timeline_ng` seeks: identical on both engines |
| 8 | Checkpoint memory: core-ng keeps checkpoints deflated (lossless) | engine 3.9.0 | a day of the 7×7 test grid: 3,047 KiB (core-legacy) → 354 KiB (core-ng), identical state at every stop (`dstns_timeline_ng`) |
| 9 | core-ng stable and the default; core-legacy selectable | engine 3.10.0 | every test passes with requests on core-ng by default; identical hashes on both engines |
| 10 | Tick: two fewer passes over the edges (#23) | engine 3.12.0 | 50×50 tick 378 → 338 µs; golden and timeline unchanged |
| 11 | Places read the edges the tick just did (#23) | engine 3.12.1 | 50×50 tick 338 → 331 µs; golden and timeline unchanged |
| 12 | Layers: `Core/common`, `Core/core-legacy` (its compiler, physics, hooks only), `Core/engines`; core-ng enforced (core-legacy off by default); `urban-geo-v2` (379 cities); no repeated city in a session | engine 3.13.0, API 1.12 | `dstns_core_ng_alone` links no core-legacy code; full suite green |
| 13 | Tick: commit stamped in the edge loop, signals from a per-tick phase table, per-world edge constants, branchless speed and queue updates, coupling read only near disturbed roads, a compact event heap (#23 closed) | engine 3.13.1 | 50×50 tick 331 → 237 µs; golden and timeline unchanged |
| last | `core-ng` the default and the only engine enabled; docs, Fabric, WebKit, end-to-end | done by 3.13.0 | full start, regenerate (`dstns_http_no_repeat`), observe, save, replay |

The launcher offers a setting only from the release in which the server honours it.

### Phase order

1. **core-ng** (releases 2, 3, 5, 6, 7 above). The server accepts `engine` in the start request; tests select
   `core-ng` directly. The launcher does not offer the choice yet.
2. **Launcher** (LaunchKit minor releases): a structured reset; SUMO settings, SUMO off by default; easier launch
   codes; a setting for every engine and interface feature; MCP typed tools, safety annotations, resources and prompts.
3. **Integration**: `engines.selected` and the selection settings in the launcher, end-to-end tests.
4. **The rest**: label language (release 4), measured optimisations (8+), `core-ng` as the default.

### Reset scopes (launcher phase)

| Command | Clears |
|---|---|
| `reset runtime` | logs, journal, checkpoints, temporary scenarios, SUMO runs |
| `reset cache` | map cache, Fastboot's next world and downloaded cities |
| `reset settings` | `config/defaults.json` and `config/ui-config.json` back to their defaults |
| `reset setup` | the setup flag; setup runs again at the next start |
| `reset seeds` | saved seeds |
| `reset keys` | provider keys, in `config/launcher.env` and the OS credential store |
| `reset apps` | connected applications (`config/apps.json`) |
| `reset app-settings [ID]` | WebFabric settings and storage of one or every application |
| `reset` | everything above except `apps` and `app-settings` |
| `reset all` | everything above |

Every scope refuses while a server runs, lists what it will delete, and asks first (`--yes` without a terminal).

### State-machine rule for core-ng

No implicit machines in core-ng: each state lives in one enum, changes through one transition function, and has a
test for each allowed and each forbidden transition. Each core-ng release lists the implicit states it found in the
code it replaces, and the faults fixed, in `docs/design/state-machines.md`.

Release 5a (3.2.1) put the engine lifecycle's table in core-ng, checks every transition against it, and fixed four
faults the audit found; see `docs/design/state-machines.md`.

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
with revert commits. At run time the operator sets `engines.selected` back to `core-legacy`.
