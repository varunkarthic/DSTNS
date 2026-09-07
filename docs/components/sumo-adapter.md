# SUMO Export and Process Bridge (`dstns::SumoBridge`)

## Purpose
Exports SUMO plain XML, invokes the external `netconvert` and `sumo` executables, and parses aggregate trip results. The repository does not implement a libsumo in-process adapter or feed microscopic telemetry back into `GraphStore`.

## Responsibilities
- Export canonical DSTNS graph topologies into SUMO plain-XML definition files:
  - `network.nod.xml`: Node coordinates and junction types.
  - `network.edg.xml`: Directed edge links, lengths, lane counts, priority, and speed limits.
  - `sandbox.rou.xml`: Vehicle types and pre-calculated deterministic trip paths.
  - `sandbox.add.xml`: Bus stop definition anchors.
  - `sandbox.sumocfg`: Master SUMO configuration.
- Omit topology-only `synthetic_reverse` edges so the microscopic network preserves OSM one-way restrictions.
- Discover and invoke the SUMO CLI tools (`netconvert`, `sumo`).
- Parse `tripinfo.xml` into vehicle count and aggregate mean travel, waiting, time-loss, and route-length values.

## Public Interface Definition
```cpp
class SumoBridge {
public:
    static SumoEnvironment detect();
    static void export_bundle(const Scenario&, const std::filesystem::path&);
    static bool build_network(const std::filesystem::path&, const SumoEnvironment&, std::string& error_out);
    static nlohmann::json simulate(const Scenario&, const std::filesystem::path&, std::uint32_t begin_s = 0, std::uint32_t end_s = 3600, const SumoEnvironment* = nullptr);
};
```
