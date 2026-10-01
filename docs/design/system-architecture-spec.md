# SUMO Deterministic Sandbox — C++ System Architecture

**Document:** 02/03  
**Purpose:** Define modules, class boundaries, preprocessing pipeline, SUMO integration, runtime concurrency, state ownership, deterministic routing, and implementation sequencing.

---

## 1. Architectural objective

The sandbox should be a **deterministic scenario compiler + runtime controller** around SUMO.

SUMO should not own the scenario semantics. The C++ system owns:

- global seed and substreams;
- map selection;
- road-only graph extraction;
- bidirectional normalization;
- canonical IDs;
- bus-stop generation;
- synthetic building placement;
- traffic hotspot selection;
- demand schedule;
- DWS schedule and flood state;
- route planning;
- event stacks;
- news generation;
- playback mapping;
- control history;
- JSON API.

SUMO owns:

- microscopic car-following;
- lane changes;
- junction conflict resolution;
- traffic-light state execution;
- vehicle positions/speeds;
- lane/edge telemetry;
- simulation stepping.

For a C++ application, **libsumo** is the preferred runtime bridge when a GUI/multi-client SUMO server is not required because it exposes TraCI-like APIs in-process without socket overhead.

---

## 2. Top-level component graph

```text
+--------------------------------------------------------------+
|                       SandboxApplication                     |
+--------------------------------------------------------------+
        |                 |                 |             |
        v                 v                 v             v
+---------------+ +---------------+ +---------------+ +---------+
| Config/Seed   | | Scenario      | | Runtime       | | API     |
| Bootstrap     | | Compiler      | | Coordinator   | | Server  |
+---------------+ +---------------+ +---------------+ +---------+
                         |                 |
                         v                 v
                  +-------------+    +-------------+
                  | Canonical   |    | Event       |
                  | GraphStore  |<-->| Executor    |
                  +-------------+    +-------------+
                    |    |    |          |     |
                    |    |    |          |     +--> NewsBus
                    |    |    |          +--------> History
                    |    |    +-------------------> DWS
                    |    +------------------------> Traffic
                    +-----------------------------> RoutePlanner
                         |
                         v
                  +-------------+
                  | SUMOAdapter |
                  |  (libsumo)  |
                  +-------------+
```

---

## 3. Source tree recommendation

```text
sandbox/
├── CMakeLists.txt
├── config/
│   ├── defaults.json
│   ├── road_types.json
│   ├── building_profiles.json
│   └── schema/
├── include/sandbox/
│   ├── app/
│   ├── core/
│   ├── rng/
│   ├── graph/
│   ├── osm/
│   ├── preprocess/
│   ├── routing/
│   ├── traffic/
│   ├── weather/
│   ├── events/
│   ├── playback/
│   ├── sumo/
│   ├── api/
│   ├── telemetry/
│   └── persistence/
├── src/
│   └── ... matching include tree ...
├── tests/
│   ├── unit/
│   ├── property/
│   ├── replay/
│   └── integration/
├── tools/
│   ├── build_road_index/
│   └── scenario_inspect/
└── docs/
```

---

## 4. Core data model

### 4.1 Strong IDs

Do not pass raw integers everywhere.

```cpp
struct NodeId  { uint32_t value; };
struct EdgeId  { uint32_t value; };
struct EventId { uint64_t value; };
struct StopId  { uint32_t value; };
```

Use canonical IDs for all public API references.

### 4.2 Node object

```cpp
enum class NodeRole : uint32_t {
    None         = 0,
    BusStop      = 1u << 0,
    TrafficLight = 1u << 1,
    Building     = 1u << 2,
    WeatherEpicenterCapable = 1u << 3
};

enum class BuildingType : uint8_t {
    None,
    School,
    Office,
    Mall,
    Store
};

struct NodeStatic {
    NodeId id;
    int64_t osm_node_id;
    int32_t lat_e7;
    int32_t lon_e7;
    int64_t x_mm;
    int64_t y_mm;
    uint16_t degree;
    NodeRole roles;
    BuildingType building_type;
    float building_impact;
    float building_radius_m;
    float flood_susceptibility;
    float drainage;
};

struct NodeDynamic {
    float rainfall;          // 0..1
    float flood;             // 0..1
    float congestion;        // 0..1 if node aggregate is exposed
    float building_effect;   // 0..1
    uint64_t state_revision;
};
```

### 4.3 Edge object

```cpp
enum class RoadClass : uint8_t {
    Motorway,
    Trunk,
    Primary,
    Secondary,
    Tertiary,
    Unclassified,
    Residential,
    LivingStreet,
    Service,
    Link,
    OtherRoad
};

struct EdgeStatic {
    EdgeId id;
    NodeId from;
    NodeId to;
    EdgeId reverse_twin;

    int64_t osm_way_id;
    uint32_t source_segment_index;
    RoadClass road_class;

    bool source_oneway;
    int8_t source_oneway_direction;
    bool synthetic_reverse;

    uint16_t lanes;
    uint32_t length_mm;
    float free_speed_mps;
    float base_capacity_vph;

    float hotspot_susceptibility;
    float flood_susceptibility;
};

struct EdgeDynamic {
    float demand_vph;
    float effective_capacity_vph;
    float effective_speed_mps;

    float rainfall;
    float flood;
    float congestion_model;
    float congestion_observed;
    float congestion;

    float signal_multiplier;
    float manual_speed_multiplier;
    float manual_capacity_multiplier;

    uint32_t vehicle_count;
    uint32_t halting_count;
    float mean_speed_mps;
    float occupancy;

    bool closed;
    uint64_t state_revision;
};
```

### 4.4 Building profile

```cpp
struct TimeWindow {
    uint32_t start_ppm; // 0..1,000,000 normalized day
    uint32_t end_ppm;
    uint8_t rise_power;
    uint8_t fall_power;
};

struct BuildingProfile {
    BuildingType type;
    std::vector<TimeWindow> tmax;
    float impact;
    float radius_m;
    float weekend_impact_multiplier;
    float weekend_radius_multiplier;
};
```

Using integer parts-per-million for normalized time prevents fragile event comparisons on raw floating-point percentages.

---

## 5. `GraphStore`

`GraphStore` is the single authoritative canonical topology/state repository.

```cpp
class GraphStore {
public:
    std::span<const NodeStatic> nodes() const;
    std::span<const EdgeStatic> edges() const;

    const NodeStatic& node(NodeId) const;
    NodeDynamic& nodeState(NodeId);

    const EdgeStatic& edge(EdgeId) const;
    EdgeDynamic& edgeState(EdgeId);

    std::span<const EdgeId> outgoing(NodeId) const;
    std::span<const EdgeId> incoming(NodeId) const;

    uint64_t topologyRevision() const;
    uint64_t stateRevision() const;
};
```

Implementation rules:

- static arrays are immutable after scenario compilation;
- dynamic arrays are contiguous and indexed by canonical IDs;
- adjacency lists are sorted by edge ID;
- no runtime topology mutation unless a future explicit topology-edit feature is introduced;
- API reads use snapshots/read locks rather than directly observing partially updated state.

---

## 6. RNG subsystem

```cpp
enum class RngDomain : uint32_t {
    MapSelection,
    BusStops,
    Buildings,
    TrafficControl,
    TrafficOD,
    TrafficSignals,
    DwsSchedule,
    DwsField,
    DaySelector
};

struct RngAddress {
    RngDomain domain;
    uint64_t object;
    uint32_t purpose;
    uint32_t draw;
};

class DeterministicRng {
public:
    uint32_t u32(RngAddress) const;
    uint64_t u64(RngAddress) const;
    double uniform01(RngAddress) const;
    uint32_t bounded(RngAddress, uint32_t bound) const;
};
```

The implementation should be stateless from the caller's perspective. Philox or another counter-based generator is preferred.

The domain key is derived from the global seed and versioned namespace.

---

## 7. OSM ingestion architecture

### 7.1 `OsmRoadProvider`

Responsibilities:

- open regional OSM XML/PBF or a prebuilt road index;
- apply road allowlist/access filtering;
- expose only road-referenced nodes/ways;
- preserve source IDs/tags;
- never expose unrelated POIs/polygons to the scenario compiler.

```cpp
class OsmRoadProvider {
public:
    RoadAnchorIndex loadAnchorIndex(...);
    RawRoadComponent fetchAroundAnchor(...);
};
```

### 7.2 Global-scale operation

For a planet/very-large extract, do not scan the whole OSM file at startup. Build a persistent road anchor/tile index offline.

Index content:

```text
TileHeader
  tile_id
  eligible_node_count
  byte/file offsets or PBF block references

AnchorRecord
  osm_node_id
  lat_e7
  lon_e7
  source block reference
```

Runtime seed selection becomes an indexed lookup rather than an internet-dependent query.

### 7.3 OSM snapshot immutability

A seed cannot reproduce a map if OSM data silently changes. Therefore store:

```text
source filename / snapshot date
SHA-256 of source or index manifest
RoadAnchorIndex version
road filter version
```

---

## 8. Scenario compiler pipeline

```text
ConfigurationLoader
      |
      v
SeedResolver -> ReproducibilityManifest
      |
      v
OsmRoadProvider
      |
      v
MapSelectionEngine (root + CRFG)
      |
      v
DRNCP
      |
      +--> canonical Node/Edge IDs
      |
      v
InfrastructureGenerator
      |-- BusStopPlanner
      |-- BuildingPlanner
      `-- SignalPlanner
      |
      v
TrafficScenarioCompiler
      |-- TrafficHotspotPlanner
      |-- OD/DemandCompiler
      `-- SignalPlanCompiler
      |
      v
WeatherScenarioCompiler
      |
      v
EventScheduleCompiler
      |
      v
SumoNetworkExporter -> netconvert -> .net.xml/.add.xml/.rou.xml
      |
      v
ScenarioBundle
```

Every stage receives immutable input and returns a deterministic result.

---

## 9. `MapSelectionEngine`

```cpp
struct MapSelectionConfig {
    uint32_t max_nodes = 50000;
    uint32_t min_nodes = 5000;
    double min_compactness = 0.10;
    uint32_t max_anchor_attempts = 64;
};

struct MapSelectionResult {
    int64_t root_osm_node;
    RawRoadGraph graph;
    uint32_t anchor_attempt;
};
```

Algorithm:

1. choose root from RoadAnchorIndex using `MAP_SELECTION` keyed draw;
2. extract root component;
3. apply CRFG if component exceeds budget;
4. compute compactness/network viability metrics;
5. deterministically retry by `anchor_attempt` if invalid;
6. emit explicit failure if no valid region is found within the bounded retry budget.

Never silently fall back to a different nondeterministic map source.

---

## 10. DRNCP implementation

Suggested class decomposition:

```cpp
class RoadNetworkCanonicalizer {
public:
    CanonicalRoadGraph run(const RawRoadGraph&, const CanonicalizationConfig&);
private:
    void filterAndSplit(...);
    void normalizeDirection(...);
    void inferAttributes(...);
    void repairTopology(...);
    void validate(...);
    void assignCanonicalIds(...);
};
```

### 10.1 Bidirectional conversion policy

For every source segment create both directions.

Keep source geometry and lane provenance. The reverse synthetic edge must explicitly say `synthetic_reverse=true` if the source disallowed it.

Capacity policy should be configurable:

```text
DUPLICATE_DIRECTIONAL_CAPACITY
PRESERVE_PHYSICAL_CAPACITY_BUDGET
FIXED_SYNTHETIC_LANES
```

Recommended sandbox default: `FIXED_SYNTHETIC_LANES` with at least one lane each way, because the project's goal is bidirectional traversability rather than strict reconstruction of original one-way physical lane geometry.

---

## 11. SUMO network export strategy

### 11.1 Prefer canonical graph -> SUMO plain XML

Although SUMO can import OSM directly, the sandbox has already altered topology and assigned its own semantics. Therefore export the canonical graph as SUMO **plain** network files:

```text
network.nod.xml
network.edg.xml
network.con.xml   (optional; allow netconvert to infer where safe)
network.tll.xml
```

Then run `netconvert` to build `network.net.xml`.

This prevents SUMO's OSM importer from re-applying one-way interpretation after the sandbox has deliberately normalized directionality.

### 11.2 Additional files

Generate:

```text
sandbox.add.xml
  bus stops
  detectors/telemetry if used
  extra traffic-light programs if needed

sandbox.rou.xml
  deterministic vehicle departures/routes
```

### 11.3 Projection

Use one pinned projection implementation/version for canonical XY coordinates. If SUMO/PROJ performs projection, record exact versions because SUMO documents cross-platform/version projection differences.

---

## 12. Bus-stop subsystem

```cpp
class BusStopPlanner {
public:
    std::vector<BusStop> generate(
        const GraphStoreStaticView&,
        NodeId map_root,
        const BusStopConfig&,
        const DeterministicRng&);
};
```

`BusStop`:

```cpp
struct BusStop {
    StopId id;
    NodeId anchor_node;
    EdgeId materialized_edge;
    uint32_t position_mm;
    float nearest_stop_distance_m;
};
```

Pipeline:

1. candidate extraction;
2. root-based canonical scan ordering;
3. minimum-spacing acceptance;
4. maximum-coverage repair;
5. lane/edge materialization;
6. validation.

Validation:

- stop is on an edge accessible to buses;
- stop is not beyond edge length;
- stop-to-stop spacing constraint satisfied except documented fallback cases;
- every generated stop ID is stable.

---

## 13. Synthetic building subsystem

```cpp
class BuildingPlanner {
public:
    std::vector<BuildingEffect> generate(
        const GraphStoreStaticView&,
        std::span<const BusStop>,
        DayType initial_day,
        const BuildingConfig&,
        const DeterministicRng&);
};
```

Use a stop-local annulus and minimum inter-building separation.

A node can host at most one primary synthetic building in V1. Multiple roles are possible (`BUS_STOP | BUILDING`) only if explicitly permitted; default is to choose a nearby distinct node.

Building profiles are data-driven from JSON, not hard-coded switches.

---

## 14. Route planner

```cpp
class RoutePlanner {
public:
    RouteResult findRoute(NodeId source, NodeId destination,
                          const RouteCostSnapshot& costs) const;
};
```

Use custom deterministic A*.

### 14.1 Why a cost snapshot

If live edge costs mutate during A*, thread timing can make results nondeterministic. Route requests should use an immutable cost snapshot for a specific simulation revision.

```cpp
struct RouteCostSnapshot {
    uint64_t revision;
    std::vector<uint32_t> cost_ms; // quantized milliseconds
};
```

Quantized integer route cost also makes equal-cost ordering stable.

### 14.2 Route cache

Cache key:

```text
(source, destination, cost_epoch, vehicle_class)
```

Invalidate by cost epoch rather than by every telemetry tick. A 1–5 virtual-minute routing epoch is a reasonable configurable starting point.

---

## 15. Traffic Control Engine

Responsibilities:

1. determine recurrent congestion hotspot edge count;
2. estimate route-probe centrality;
3. compile OD distributions;
4. generate deterministic departure schedule;
5. compute time-varying demand pressure;
6. compute analytical congestion;
7. consume SUMO telemetry to compute observed congestion;
8. publish speed/capacity changes required by weather/manual control;
9. maintain signal plans.

```cpp
class TrafficControlEngine {
public:
    void initialize(const ScenarioStatic&);
    void beforePhysicsStep(const ClockState&);
    void afterPhysicsStep(const ClockState&, const SumoTelemetry&);

    TrafficStateSnapshot snapshot() const;
};
```

---

## 16. Traffic OD generation

### 16.1 Edge sampling distributions

Departure and arrival weights should differ.

Example departure weight:

\[
w^{dep}_e
=R^{residential}_e
+\eta_s B^{school}_e
+\eta_o B^{office}_e
+\epsilon.
\]

Arrival weight uses attraction according to current time-window building profiles.

Build alias tables for static/base distributions if desired, but random selection still uses sandbox RNG draws, not library randomness.

### 16.2 Precompiled departures

Represent each trip:

```cpp
struct PlannedTrip {
    uint64_t vehicle_number;
    uint32_t depart_virtual_s;
    EdgeId source_edge;
    EdgeId destination_edge;
    std::vector<EdgeId> initial_route;
    VehicleClass vehicle_class;
};
```

Sort by:

```text
(depart_virtual_s, vehicle_number)
```

No runtime random departure generation is needed.

---

## 17. Traffic-signal subsystem

```cpp
struct SignalPhase {
    std::string sumo_state;
    uint16_t duration_s;
};

struct SignalPlan {
    NodeId junction;
    uint16_t cycle_s;
    std::vector<SignalPhase> phases;
    uint32_t valid_from_virtual_s;
    uint32_t valid_to_virtual_s;
};
```

`SignalPlanner` decides which intersections become signals. `SignalPlanCompiler` derives timing plans from expected critical flows.

For runtime control, libsumo/TraCI-compatible traffic-light operations can set phase, phase duration, program, or complete program logic.

### 17.1 Time-of-day signal plans

Instead of recalculating every second, compile plans by virtual time interval, e.g.:

```text
00:00-06:00 off-peak
06:00-10:00 morning
10:00-15:00 day
15:00-20:00 afternoon/evening peak
20:00-24:00 night
```

Within each segment use Webster-derived values with clamps.

---

## 18. Deterministic Weather Simulation (DWS) subsystem

```cpp
struct DwsEvent {
    EventId id;
    NodeId epicenter;
    uint32_t start_ppm;
    uint32_t end_ppm;
    uint16_t peak_intensity_q16;
    uint32_t radius_mm;
    uint16_t flood_gain_q16;
    uint16_t recovery_q16;
};
```

```cpp
class DynamicWeatherSimulation {
public:
    void loadSchedule(std::span<const DwsEvent>);
    void update(const ClockState&, GraphStore&);
    WeatherSnapshot snapshot() const;
};
```

### 18.1 Spatial acceleration

Build an R-tree or uniform spatial grid over:

- node points;
- edge polyline bounding boxes.

For event radius \(R\), query only objects whose bounding boxes intersect the epicenter circle's bounding box, then apply exact point/polyline distance.

### 18.2 Flood reservoir state

Flood is dynamic state stored per node/edge. Rainfall is recomputed from active events; flooding is integrated over virtual physics steps.

### 18.3 Applying speed changes to SUMO

Use lane/edge speed controls through libsumo-compatible calls. SUMO supports changing lane maximum speed at runtime. Avoid setting arbitrary vehicle speeds because this can conflict with car-following safety behavior.

For edge closures, update route planner cost/availability and apply appropriate lane restrictions or speed/capacity mechanisms in SUMO.

---

## 19. Global Playback Control

```cpp
enum class PlaybackState { Stopped, Playing, Paused, Completed };

struct ClockState {
    PlaybackState state;
    uint32_t playback_elapsed_ms;
    uint32_t playback_duration_ms;
    uint32_t simulation_percentage_ppm;
    uint32_t virtual_day_s;
    uint32_t sumo_time_ms;
};

class GlobalPlaybackControl {
public:
    void play();
    void pause();
    void stop();
    void seek(/* optional future feature */);

    ClockState state() const;
    uint32_t targetVirtualTimeFromPlayback(...) const;
};
```

### 19.1 Deterministic stepping rule

At each controller iteration:

1. compute target virtual day time from playback position;
2. while SUMO time < target, advance by fixed `sumo_step`;
3. before each step apply scheduled events due at that virtual time;
4. update DWS/traffic controls;
5. call `libsumo::Simulation::step` / equivalent;
6. collect telemetry;
7. publish a coherent state snapshot.

If compute falls behind, do not skip event/physics steps.

---

## 20. Event model

```cpp
enum class EventType {
    DemandWindowStart,
    DemandWindowEnd,
    SignalPlanChange,
    WeatherStart,
    WeatherEnd,
    DayOverride,
    ManualWeather,
    ManualTraffic,
    ModuleEnable,
    ModuleDisable
};

struct ScheduledEvent {
    EventId id;
    EventType type;
    uint32_t execute_ppm;
    uint32_t type_priority;
    uint32_t target_number;
    EventPayload payload;
};
```

### 20.1 Two deterministic schedule stacks

```text
TemporalDemandStack
WeatherEventStack
```

Compile in descending time and push such that the earliest event is topmost.

Do **not** use the undo stack as the schedule stack.

### 20.2 Runtime event executor

```cpp
class EventExecutor {
public:
    void executeDue(const ClockState&);
    AppliedEventRecord apply(const ScheduledEvent&);
};
```

Applied event state records before/after parameter deltas needed for logical undo.

---

## 21. Control history, undo and redo

Three distinct concepts must not be conflated:

1. **Scheduled event stack** — future deterministic events.
2. **Control command history** — user/manual actions.
3. **Undo/redo stacks** — inverse/redo records for already applied state changes.

```cpp
struct MutationDelta {
    TargetRef target;
    DynamicField field;
    Value before;
    Value after;
};

struct AppliedCommand {
    uint64_t command_id;
    uint32_t applied_virtual_s;
    std::vector<MutationDelta> deltas;
    std::string source; // scheduled/manual
};
```

Undo:

- applies `before` values in reverse delta order;
- pushes the command onto redo stack.

Redo:

- applies `after` values in forward order;
- pushes back onto undo stack.

### 21.1 Important semantic limitation

A parameter undo does **not** rewind vehicles that already reacted to an event. For example, removing a rain event does not teleport vehicles back to their pre-rain positions.

If true temporal rollback is required, implement checkpoint-based rewind:

- save SUMO state;
- save sandbox graph dynamic state;
- save schedule positions;
- save control journal position;
- restore and replay commands.

SUMO supports state save/load, but its documentation notes limitations and platform-dependent RNG-state portability. Therefore V1 should define undo as **logical effect reversal**, not time travel.

---

## 22. Custom event semantics

A custom event invoked through Control:

- does not modify immutable seed-derived schedule stacks;
- receives a unique `command_id`;
- is applied through the same event executor;
- is written to the control journal;
- may participate in undo/redo;
- can be exactly replayed with the control journal.

Hence the base seed remains reproducible, and an interactive run is reproducible from `base seed + journal`.

---

## 23. DWS five-second conflict gate

Manual DWS and scheduled DWS events pass through `WeatherAdmissionController`.

```cpp
class WeatherAdmissionController {
public:
    AdmissionResult request(const WeatherRequest&, const ClockState&);
};
```

Rules in playback-time domain:

1. let `last_start_playback_s` be the most recently admitted DWS event start;
2. earliest permitted start is
   \[
   t_{earliest}=last\_start+5s;
   \]
3. if request arrives before that, schedule it at `t_earliest`;
4. if a seed-derived future DWS event would violate the separation, its precompiled start was already generated with the spacing formula and therefore cannot conflict;
5. traffic/congestion manual events bypass this gate.

A delayed manual weather event is an overlay event, not inserted into the immutable base WeatherEventStack.

---

## 24. Module enable/disable semantics

Modules:

```text
TrafficDemand
TrafficSignals
TrafficHotspots
Buildings
DWS
Flooding
News
```

### Startup disabled

If disabled in startup configuration, its seed-derived schedule may be omitted entirely from the compiled scenario bundle.

### Runtime disabled

If disabled by Control:

- future base schedule remains immutable;
- executor marks module events as `suppressed` while disabled;
- dynamic module contribution moves to its neutral value;
- re-enabling resumes future events; past suppressed events are not retroactively applied unless explicitly requested.

This policy is simple, auditable, and replayable.

---

## 25. Runtime single-writer concurrency model

### 25.1 Threads

```text
Thread A: Simulation/Main State Thread     [ONLY WRITER]
Thread B: HTTP/WebSocket I/O
Thread C..N: Serialization / read-only workers (optional)
```

### 25.2 Command queue

API does not mutate GraphStore.

```cpp
struct ControlCommandEnvelope {
    uint64_t sequence;
    uint64_t received_monotonic_ns; // diagnostic only
    ControlCommand command;
};
```

At a simulation safe-point, drain commands and sort/apply by `sequence`.

If commands arrive concurrently, sequence is assigned by one atomic monotonic counter at ingress. Replay uses the journal sequence, not wall time.

### 25.3 Snapshot publication

After a completed simulation step:

1. increment state revision;
2. build/refresh immutable `ReadSnapshot`;
3. atomically publish snapshot pointer;
4. API readers serialize the published snapshot.

No reader can observe half-updated DWS/traffic/SUMO state.

---

## 26. Telemetry adapter

`SumoAdapter` should collect only what is needed at a configured cadence.

```cpp
struct EdgeTelemetry {
    EdgeId edge;
    uint32_t vehicle_count;
    uint32_t halting_count;
    float mean_speed_mps;
    float occupancy;
};
```

Do not query every vehicle property every step unless required. SUMO documentation explicitly notes TraCI call overhead; in-process libsumo is preferred for performance-sensitive coupling.

---

## 27. `SumoAdapter`

```cpp
class SumoAdapter {
public:
    void start(const ScenarioBundle&);
    void close();

    void step(double virtual_time_s);

    void setLaneMaxSpeed(const std::string& lane_id, double mps);
    void setTrafficLightProgram(...);
    void setTrafficLightPhaseDuration(...);

    SumoTelemetry collectTelemetry(const TelemetryPlan&);
};
```

Keep a stable mapping:

```text
canonical EdgeId -> SUMO edge ID(s) -> lane IDs
canonical NodeId -> SUMO junction ID
StopId -> SUMO busStop ID
```

Never parse identity back from arbitrary SUMO-generated strings at runtime.

---

## 28. Scenario bundle

A compiled run directory:

```text
run_<id>/
├── manifest.json
├── config.resolved.json
├── graph.canonical.bin
├── graph.summary.json
├── event_schedule.bin
├── traffic_plan.bin
├── dws_plan.bin
├── network.nod.xml
├── network.edg.xml
├── network.tll.xml
├── network.net.xml
├── sandbox.add.xml
├── sandbox.rou.xml
└── logs/
```

A scenario can therefore be inspected before simulation starts.

---

## 29. Persistence / replay

`ReplayManager` stores:

```text
base scenario bundle hash
resolved global seed
control journal
optional periodic checkpoints
final metrics
```

Replay modes:

### `BASE_REPLAY`

Same scenario, no interactive control.

### `JOURNAL_REPLAY`

Reapply every external command at its recorded logical sequence/virtual time.

### `CHECKPOINT_REPLAY`

Restore a checkpoint and replay only subsequent journal entries.

---

## 30. Failure policy

Never “fix” deterministic errors with hidden randomness.

Examples:

### Invalid selected map

```text
Try deterministic next anchor attempt.
After max attempts -> startup error MAP_SELECTION_EXHAUSTED.
```

### Bus-stop coverage impossible

```text
Emit warning with uncovered percentage.
Use documented fallback candidate only if enabled.
```

### DWS frequency exceeds five-second spacing feasibility

```text
Reject config or clamp only if config explicitly allows clamping.
Expose resolved value in manifest.
```

### SUMO network conversion failure

```text
Abort startup and preserve generated plain XML plus netconvert stderr.
```

---

## 31. Deterministic testing strategy

### 31.1 Golden scenario hash

For fixed small OSM fixture and seed:

```text
hash(canonical graph)
hash(bus stops)
hash(buildings)
hash(signal plans)
hash(DWS schedule)
hash(traffic schedule)
```

must remain unchanged unless `algorithm_version` is deliberately incremented.

### 31.2 Property tests

Examples:

```text
Every edge has a reverse twin.
No normalized field leaves [0,1].
No stop pair is < min spacing unless explicitly exempt.
Every DWS start pair is >= 5 playback seconds.
DWS spatial influence is zero at/after radius.
Same seed produces same schedule under shuffled processing order.
Changing DWS code does not change Traffic RNG values.
```

### 31.3 Metamorphic tests

- doubling playback duration must not change normalized event percentages;
- disabling News must not change traffic/weather state;
- changing JSON serialization order must not change scenario hashes;
- adding an API reader must not alter simulation state;
- executing preprocessing with 1 vs N worker threads must produce the same canonical output.

---

## 32. Performance guidance for 50,000 nodes

1. Use contiguous vectors indexed by canonical IDs.
2. Use CSR-like adjacency rather than per-node heap allocations.
3. Build spatial index once.
4. Quantize route costs into integers.
5. Recompute dynamic route-cost epochs periodically, not per vehicle per second.
6. Prefer libsumo over socket TraCI for the C++ runtime.
7. Update only DWS-affected spatial subsets.
8. Batch SUMO state changes.
9. Snapshot API data at telemetry cadence, not every physics substep.
10. Make expensive metrics (route-probe centrality) preprocessing-only.

---

## 33. Recommended implementation phases

### Phase 1 — Deterministic core

- config parser;
- global seed;
- Philox/counter RNG;
- canonical IDs;
- GraphStore;
- replay manifest.

### Phase 2 — OSM + DRNCP

- road-only source reader;
- CRFG region selection;
- direction normalization;
- plain SUMO export;
- netconvert integration.

### Phase 3 — SUMO runtime

- libsumo startup/step/shutdown;
- canonical-to-SUMO ID mapping;
- telemetry;
- playback controller.

### Phase 4 — deterministic traffic

- A*;
- route probes;
- hotspots;
- demand bins;
- planned trips;
- congestion metrics.

### Phase 5 — infrastructure

- bus stops;
- buildings;
- traffic signals;
- Webster plan compiler.

### Phase 6 — DWS

- schedule frequency;
- event spacing;
- radial intensity;
- flood reservoir;
- speed/capacity coupling.

### Phase 7 — events/API

- event stacks;
- news bus;
- view/news/control JSON;
- logical undo/redo;
- journal replay.

### Phase 8 — hardening

- property tests;
- golden hashes;
- fuzz config/API;
- load test 50k nodes;
- checkpoint support if required.

---

## 34. Suggested C++ interfaces

```cpp
class SandboxApplication {
public:
    int run(const LaunchArguments&);

private:
    Config config_;
    ReproducibilityManifest manifest_;
    DeterministicRng rng_;

    ScenarioCompiler compiler_;
    Scenario scenario_;

    GraphStore graph_;
    RoutePlanner router_;
    TrafficControlEngine traffic_;
    DynamicWeatherSimulation dws_;
    EventExecutor events_;
    GlobalPlaybackControl playback_;
    SumoAdapter sumo_;
    NewsBus news_;
    ControlHistory history_;
    ApiServer api_;
};
```

Runtime loop concept:

```cpp
while (!playback_.completed()) {
    applyApiCommandsAtSafePoint();

    if (playback_.paused()) {
        publishSnapshotIfNeeded();
        continue;
    }

    const auto target = playback_.targetVirtualTime();

    while (sumo_.time() < target) {
        const ClockState clock = playback_.clockForSumoTime(sumo_.time());

        events_.executeDue(clock);
        dws_.update(clock, graph_);
        traffic_.beforePhysicsStep(clock);

        sumo_.applyPendingStateChanges();
        sumo_.step(clock.nextSumoTime());

        auto telemetry = sumo_.collectTelemetry(...);
        traffic_.afterPhysicsStep(clock, telemetry);

        graph_.commitStateRevision();
    }

    publishReadSnapshot();
}
```

---

## 35. Key architectural decisions to keep

1. **Canonical graph before SUMO.**
2. **Counter-based RNG, not chained RNG state.**
3. **Stable IDs and integer tie-breaks.**
4. **SUMO time is virtual-day physics time; playback is presentation compression.**
5. **Custom A* routing.**
6. **Bus stops use graph-spacing + coverage repair.**
7. **Weather uses spatial kernel + temporal kernel + flood reservoir.**
8. **Congestion coupling occurs through effective speed/capacity.**
9. **Immutable seed-derived schedules plus overlay manual commands.**
10. **Single-writer runtime and replayable command journal.**

---

## 36. Relevant SUMO references

- OpenStreetMap import: https://sumo.dlr.de/docs/Networks/Import/OpenStreetMap.html
- netconvert: https://sumo.dlr.de/docs/netconvert.html
- libsumo: https://sumo.dlr.de/docs/Libsumo.html
- TraCI overview/performance: https://sumo.dlr.de/docs/TraCI/
- Runtime traffic-light control: https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html
- Lane runtime state changes: https://sumo.dlr.de/docs/TraCI/Change_Lane_State.html
- Routing/custom weights background: https://sumo.dlr.de/docs/Simulation/Routing.html
- Randomness/reproducibility: https://sumo.dlr.de/docs/Simulation/Randomness.html
- Save/load caveats: https://sumo.dlr.de/docs/Simulation/SaveAndLoad.html
- SUMO public transport/bus stop representation: https://sumo.dlr.de/docs/Simulation/Public_Transport.html

