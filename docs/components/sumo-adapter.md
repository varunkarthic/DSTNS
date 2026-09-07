# SUMO Integration & Export (`dstns::engine`)

## Purpose
Provides plain-XML and libsumo interfaces to Eclipse SUMO (Simulation of Urban MObility) for microscopic vehicle kinematics, car-following, lane changing, and junction conflict physics.

## Responsibilities
- Export canonical DSTNS graph topologies into SUMO plain-XML definition files:
  - `network.nod.xml`: Node coordinates and junction types.
  - `network.edg.xml`: Directed edge links, lengths, lane counts, priority, and speed limits.
  - `routes.rou.xml`: Vehicle types and pre-calculated A* deterministic trip paths.
  - `additional.add.xml`: Bus stop definition anchors.
  - `sandbox.sumocfg`: Master SUMO configuration.
- Omit topology-only `synthetic_reverse` edges so the microscopic network preserves OSM one-way restrictions.
- Integrate with SUMO CLI tools (`netconvert`, `sumo`) and `libsumo` in-process API.
- Read microscopic telemetry (lane mean speeds, vehicle counts, waiting times) and ingest them into `GraphStore` dynamic channels.

## Public Interface Definition
```cpp
class ISumoAdapter {
public:
    virtual ~ISumoAdapter() = default;
    virtual void initialize(const std::filesystem::path& config_file) = 0;
    virtual void step(double target_virtual_time_s) = 0;
    virtual void close() = 0;
};
```
