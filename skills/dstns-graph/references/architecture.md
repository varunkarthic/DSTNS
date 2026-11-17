# DSTNS: what is where

A seed chooses a real district of a real city, and DSTNS simulates a whole day there. The engine is C++20; the
launcher is Rust; the observer is TypeScript and React; the documentation is MkDocs. `areas` in the script counts the
graph's items per part.

## The parts

| Part (`areas`) | Folder | What it is | Start reading at |
|---|---|---|---|
| Core | `Core/common` | The host every engine runs in: lifecycle, clock, operator commands and undo, world jobs, views, news, the model, maps, events, weather helpers, the SUMO bridge | `Core/common/include/dstns/engine.hpp` (`SimulationEngine`), `Core/common/src/engine.cpp` |
| Core | `Core/core-ng` | The engine: selection, compiler, physics tick, checkpoints, lifecycle and world-job tables | `Core/core-ng/src/selection.cpp`, `compile.cpp`, `physics.cpp`, `timeline.cpp` |
| Core | `Core/core-legacy` | The engine before core-ng, kept for comparison and disabled by default | `Core/core-legacy/src/scenario.cpp`, `physics.cpp` |
| Core | `Core/engines` | Registers the installed engines | `Core/engines/src/engines.cpp` |
| Core | `Core/server` | The server process: arguments, signals, the parent watchdog | `Core/server/main.cpp` |
| Fabric | `Fabric/src` | The HTTP API, one file per group of routes, and its guards | `routes_playback.cpp`, `routes_control.cpp`, `routes_view.cpp`, `routes_system.cpp`, `routes_engine.cpp`, `guards.cpp`, `gate.cpp` |
| Fabric | `Fabric/src/webfabric` | Applications: registration, capabilities, signing, the audit chain, storage | `Fabric/src/webfabric/registry.cpp` |
| Daemon | `Daemon/src` | Watchers inside the server (resources, memory, disk, stalled runs) and their queues | `Daemon/src/handler.cpp`, `Daemon/messages.json` |
| LaunchKit | `LaunchKit/src` | The launcher: commands, settings, server supervision, launch codes, MCP Handler, the interface | `cli.rs` (commands), `config.rs` (every setting), `server.rs`, `session.rs`, `state.rs` (launch codes), `modules/mcp.rs`, `tui/` |
| WebKit | `WebKit/src` | The observer: map, telemetry, Time Control, notifications, WebFabric, the report, the start-up film | `App.tsx`, `panels/`, `map/`, `film/`, `webfabric/`, `report/` |
| CoreAI | `CoreAI` | The shared model layer for the launcher's assistant and the engine's news | `CoreAI/src/` |
| docs | `docs` | The documentation site; `docs/api/openapi.yaml` describes every route | `docs/guide/`, `docs/api/`, `docs/design/` |
| tests | `tests` | Engine and HTTP suites: `unit`, `http`, `property`, `replay`, `performance`, and golden fixtures | `tests/unit/golden_tests.cpp`, `tests/http/harness.hpp` |
| tools | `tools` | `benchmark`, `stress/lifecycle.py`, `release`, `replay-verify` | `tools/benchmark/` |
| config | `config` | Settings and their JSON Schemas; `engines.json` is the engine policy | `config/defaults.json`, `config/engines.json`, `config/schema/` |

## How a run flows

1. The launcher (`LaunchKit/src/session.rs`) builds what changed, starts or reuses a server (`server.rs`), and sends
   `POST /api/v1/playback/start` (`Fabric/src/routes_playback.cpp`).
2. The host (`SimulationEngine`, `Core/common`) moves through its lifecycle and asks the world's engine, through
   `ScenarioCompiler::Hooks`, to `select` a city, `compile` the district, `step` each second, and `capture` and
   `rewind` checkpoints.
3. core-ng does those in `selection.cpp`, `compile.cpp` (`network.cpp`, `plans.cpp`), `physics.cpp` and
   `timeline.cpp`. Every lifecycle and world-job transition is checked against `lifecycle.cpp` and `world.cpp`.
4. The observer (`WebKit`) reads views (`routes_view.cpp`) and shows them.

## Names worth knowing

| Name | What it is |
|---|---|
| `SimulationEngine` | The host: lifecycle, clock, commands, the world |
| `ScenarioCompiler::Hooks` | The seam through which an engine takes over each stage |
| `Seed128` | A seed of up to 128 bits; `derive` gives each subsystem its own stream |
| `select_location` | core-ng's choice of city and anchor for a seed and policy |
| `physics_step` | One simulated second, in each engine's `physics.cpp` |
| `EngineGate` | The unstable-engine gate (`Fabric/src/gate.cpp`) |
| `AppRegistry` | WebFabric's applications (`Fabric/src/webfabric/registry.cpp`) |
| `urban-crfg-v3`, `urban-geo-v1`, `urban-geo-v2` | The selection policies: 181, 181 and 379 cities |
