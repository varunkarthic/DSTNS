# DSTNS Architecture Context

## 1. System Overview & Core Purpose
**DSTNS** (Deterministic Spatiotemporal Transport Network Simulator) is a high-performance C++20 urban road network scenario compiler, simulation runtime, and telemetry engine paired with a React/Vite/MapLibre GL operator dashboard and an Eclipse SUMO microscopic physics bridge.

Its primary architectural invariant is **strict bit-for-bit determinism**: given an identical 128-bit master seed and scenario configuration, the entire simulation lifecycle—comprising map sub-network extraction, traffic signal phases, public transit bus stop layout, deterministic weather simulation (DWS), background vehicle trips, stochastic incident desk occurrences, and telemetry ledgers—executes identically and reproducibly across runs, restarts, and backward/forward seeks.

---

## 2. Major Components & Responsibilities

```
+-----------------------------------------------------------------------------------+
|                                Operator Frontend                                   |
|   React 19 + TypeScript + Vite + MapLibre GL UI (Canvas/WebGL, Playback, Stacks)  |
+-----------------------------------------+-----------------------------------------+
                                          | HTTP REST / SSE Stream
                                          v
+-----------------------------------------------------------------------------------+
|                         ApiServer (cpp-httplib Engine)                            |
|       /api/v1/playback/*, /api/v1/view/*, /api/v1/control/*, /api/v1/news/*       |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                     SimulationEngine (Authority & Lifecycle)                      |
|  - Playback State Machine (IDLE, RUNNING, PAUSED, SEEKING, STOPPED, COMPLETED)    |
|  - Clock Scaling (Virtual Day: 0..86400s vs Playback Wall Duration: 60..3600s)   |
|  - Checkpoint Journaling & State Reconstruction                                   |
|  - Physics Step & Dynamic Multiplier Accumulator                                  |
|  - Incident Desk Manager (Scheduled -> Active -> Resolved with Overlap Guards)   |
|  - Event Stack & News Ledger Dispatcher                                           |
+-------------------+---------------------+--------------------+--------------------+
                    |                     |                    |
                    v                     v                    v
          +-------------------+ +-------------------+ +-------------------+
          |    GraphStore     | |   ScenarioCompiler| |   SumoBridge      |
          |  Static/Dynamic   | |  Offline Grid &   | |  Plain XML Net/   |
          |  Road Topology    | |  OSM Ingestion    | |  Route Exporter   |
          +-------------------+ +-------------------+ +-------------------+
                    ^                     ^
                    |                     |
          +---------+---------------------+---------+
          |             SeedManager &               |
          |          DeterministicRng               |
          |  Domain-Separated Sub-Seeds via SHA-256 |
          +-----------------------------------------+
```

### Component Details
1. **SeedManager & DeterministicRng (`dstns/rng.hpp`, `src/rng.cpp`)**:
   - Represents 128-bit master seeds (`high`, `low`).
   - Derives domain-separated sub-seeds using cryptographic hashing (`sha256(master.hex() + ":" + domain)`).
   - Generates deterministic pseudo-random sequences via counter-addressed Philox-4x32-10 PRNG.
2. **OsmRoadLoader (`dstns/osm.hpp`, `src/osm.cpp`)**:
   - Parses OpenStreetMap XML geometries and attributes.
   - Filters non-vehicular ways, retains directional provenance (`synthetic_reverse` twins).
   - Partitions anchors into geographic sectors and performs Connected Radial Frontier Growth (CRFG).
   - Validates candidate subgraphs against connectivity and density thresholds with deterministic retries.
3. **ScenarioCompiler (`dstns/scenario.hpp`, `src/scenario.cpp`)**:
   - Orchestrates static road network compilation (from OSM XML or canonical synthetic grid).
   - Places public transit bus stops based on graph distance spacing and coverage repair.
   - Plans traffic signal cycles, phase splits, and green wave offsets.
   - Synthesizes background trip demand matrices and routes via `RoutePlanner` (A*).
   - Compiles DWS (Deterministic Weather Simulation) storm cells.
   - Compiles deterministic stochastic incidents with temporal distribution across early, middle, and late slots.
   - Computes canonical cryptographic hashes (`map_hash`, `graph_hash`, `event_hash`, `scenario_hash`).
4. **GraphStore & RoutePlanner (`dstns/graph.hpp`, `src/graph.cpp`)**:
   - Strict separation between static geometric/topological data (`NodeStatic`, `EdgeStatic`) and runtime dynamic states (`NodeDynamic`, `EdgeDynamic`).
   - A* heuristic pathfinder respecting source-direction restrictions and dynamic road closures / speed degradation.
5. **SimulationEngine (`dstns/engine.hpp`, `src/engine.cpp`)**:
   - Sole authority over simulation time, execution stepping, command undo/redo, checkpoint capture, and state restoration.
   - Executes analytical macroscopic edge physics: Bureau of Public Roads (BPR) congestion, signal multipliers, environmental DWS rain and flood deceleration, and incident restrictions.
   - Maintains the Active Incident tracker with reference tracking so resolving one incident never prematurely clears overlapping incidents.
6. **ApiServer (`dstns/api.hpp`, `src/api.cpp`)**:
   - Exposes REST endpoints and SSE streams for playback, views, manual controls, and news.
7. **RuntimeLogger (`dstns/logging.hpp`, `src/logging.cpp`)**:
   - Dual persistence: human-readable log file (`logs/system.log`) and SQLite WAL database (`logs/runtime.db`).
8. **SumoBridge (`dstns/sumo_bridge.hpp`, `src/sumo_bridge.cpp`)**:
   - Exports network XML (`.nod.xml`, `.edg.xml`), routes (`.rou.xml`), and additional bus stops (`.add.xml`) for microscopic physics simulation in Eclipse SUMO.

---

## 3. Seed Pipeline & Domain Separation

To prevent cross-subsystem coupling (e.g. changing incident internals must not alter weather, and changing map selection must not alter trips), the system uses domain-separated sub-seeds derived from the 128-bit master seed:

```
                          MASTER SEED (128-bit)
                                   |
         +-------------+-----------+-----------+-------------+
         |             |           |           |             |
       "map"         "dws"     "traffic"  "incidents"     "events"
         |             |           |           |             |
      SHA-256       SHA-256     SHA-256     SHA-256       SHA-256
         v             v           v           v             v
      MAP_SEED      DWS_SEED  TRAFFIC_SEED INCIDENT_SEED  EVENT_SEED
```

### Stable Mixing & Avalanche Properties
- **Derivation formula**: `Seed128::derive(domain) := parse_hex(SHA-256(master.hex() + ":" + domain)[0..31])`.
- **Avalanche guarantee**: Flipping even a single bit in `master` (e.g. `0x1000` to `0x1001`) cascades through SHA-256, changing approximately 50% of the bits in every derived sub-seed. This completely eliminates geographic and temporal clustering between adjacent seeds.

---

## 4. OpenStreetMap Map Generation & Candidate Validation

1. **Source Ingestion**:
   - Loads OSM XML (e.g. `data/fixtures/downtown_osm.xml` or large-scale `real_network.osm.xml`).
   - Tags: nodes with bus stops, traffic signals, buildings (School, Office, Mall, Store); ways with highway classes.
2. **Directional Normalization**:
   - One-way roads are split into a legal forward edge and a `synthetic_reverse` twin. The twin preserves topological reciprocity while `is_source_direction_allowed()` ensures routing, trips, and SUMO export treat it as non-traversable.
3. **Deterministic Geographic Sector Partition**:
   - Anchors with degree $\ge 2$ are partitioned into 9 sectors (N, NE, E, SE, S, SW, W, NW, Core).
   - `MAP_SEED` picks the sector deterministically, ensuring geographically distinct regions.
4. **Connected Radial Frontier Growth (CRFG)**:
   - Expands outward from the sector root node along valid road segments via Dijkstra network distance until target node count is satisfied.
5. **Candidate Validation & Deterministic Retries**:
   - Checks that the extracted candidate contains $\ge \min(\text{target\_nodes}, 25)$ nodes, valid edge density (edges $\ge$ nodes), and non-empty bounding box.
   - Retries with attempt index $a \in [0, 15]$ deterministically addressing `candidate_pool`. Uncontrolled randomness is strictly forbidden.

---

## 5. DWS: Deterministic Weather Simulation

> **Terminology Note**: DWS stands strictly for **Deterministic Weather Simulation**. It does NOT mean Dynamic Weather Simulation.

- **Seeding**: DWS events are scheduled using `DWS_SEED = master.derive("dws")`.
- **Spatial Field**: Uses a compact Wendland $C^2$ polynomial kernel:
  $$W(r, R) = \left(1 - \frac{r}{R}\right)^4 \left(1 + 4\frac{r}{R}\right) \quad \text{for } r < R$$
- **Temporal Profile**: Three-phase continuous envelope (smooth sinusoidal expansion, sustained plateau, and cosine dissipation).
- **Drift Vector**: Wind drift vector derived deterministically from the storm event ID.
- **Surface Hydrology**: Local flood accumulation on nodes with flood susceptibility and drainage coefficients, propagating to edges.

---

## 6. Incident Subsystem Architecture

### Data Model (`Incident`)
- **Properties**:
  - `id`: Deterministic unique identifier (e.g. `600001`, `600002`, ...).
  - `type`: `RoadClosure`, `Accident`, `Congestion`, `VehicleBreakdown`, `HazardSpill`.
  - `severity`: `"low"`, `"mid"`, `"high"`.
  - `edge_id`: Valid, traversable road edge (`is_source_direction_allowed(edge)`).
  - `node_id`: Incident anchor node (incident edge `from` or `to`).
  - `start_virtual_s`, `end_virtual_s`: Virtual day start and completion times.
  - `speed_multiplier`, `capacity_multiplier`: Physical capacity/speed degradations.
  - `closes_road`: Boolean indicating total edge impassability.

### Lifecycle & Overlapping Resolution Guard
```
+----------------+      virtual_s >= start_s      +----------------+
|   SCHEDULED    | -----------------------------> |     ACTIVE     |
+----------------+                                +-------+--------+
                                                          | virtual_s >= end_s
                                                          v
                                                  +----------------+
                                                  |    RESOLVED    |
                                                  +----------------+
```
- **State Resolution Overlap Invariant**:
  When Incident A resolves on edge $E$, if Incident B is still active on edge $E$, edge $E$ is **not** prematurely restored. The effective edge state is computed as:
  $$\text{effective\_speed\_mult} = \text{manual\_speed\_mult} \times \min_{i \in \text{active}(E)} (i.\text{speed\_mult})$$
  $$\text{effective\_cap\_mult} = \text{manual\_cap\_mult} \times \min_{i \in \text{active}(E)} (i.\text{cap\_mult})$$
  $$\text{closed} = \text{manual\_closed} \lor \text{flood} \ge 0.98 \lor \bigvee_{i \in \text{active}(E)} i.\text{closes\_road}$$

### Temporal Distribution
- Incidents are scheduled deterministically using `INCIDENT_SEED`.
- Sliced into non-overlapping temporal slots (early: 10%–35%, mid-early: 35%–55%, mid-late: 55%–75%, late: 75%–90% of day).
- Normal simulations generate at least 4 incidents, distributed so every phase of playback encounters active incidents.

---

## 7. Event Stack & News Ledger
- **Event Stack**: Chronological ledger of simulation-relevant operational occurrences (DWS storm onset/peak/clearing, Incident activation/clearing, Transit dispatches, and Signal synchronizations).
- **Deterministic Ordering**: Events occurring at the exact same virtual time are resolved using stable tie-breaking:
  $$(\text{virtual\_s}, \text{priority}, \text{event\_id})$$
  where Alerts have priority 0, Warnings priority 1, and Info priority 2.

---

## 8. Playback Controls & Complete Reset Invariant

### Playback State Machine
- `prepare(seed, config)`: Precompiles scenario, loads network topology into `GraphStore`, sets lifecycle to `READY`.
- `start(seed, config)`: Precompiles scenario, clears prior run state, sets lifecycle to `RUNNING`.
- `play()` / `pause()`: Toggles virtual clock progression without losing sub-second phase.
- `seek(target_virtual_s)`: Restores nearest prior checkpoint and steps forward deterministically.
- `reset()`:
  - Halts simulation worker.
  - Releases `graph_` and scenario references.
  - Clears `manual_weather_`, `active_surges_`, `signal_overrides_`, `active_transit_buses_`, and active incident tracking.
  - Clears news, commands, redo stacks, and checkpoints.
  - Resets all ID counters (`next_news_id_`, `next_command_id_`, `next_event_id_`).
  - Sets virtual clock to 0 and transitions lifecycle to `IDLE`.
  - Guarantees zero residual state leakage between consecutive runs.
