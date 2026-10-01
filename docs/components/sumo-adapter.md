# SUMO adapter (`dstns::SumoBridge`)

The live DSTNS model is aggregate: flows and queues per directed edge. Eclipse
SUMO is a microscopic simulator: individual vehicles and car-following. The
SUMO adapter exports a DSTNS scenario as a SUMO network and demand, runs SUMO
on it as a separate batch job, and reports aggregate trip statistics. It is a
cross-check of the aggregate model, and never writes back into a live run.

Source: `include/dstns/sumo_bridge.hpp`, `src/sumo_bridge.cpp`; the export
itself is `ScenarioCompiler::export_sumo` in `src/scenario.cpp`.

## Interface

```cpp
struct SumoEnvironment {
    bool available;                       // both tools start and answer --version
    std::string sumo_version;             // e.g. "v1_27_1+0354-22511947e85"
    std::filesystem::path sumo_binary, netconvert_binary, sumo_home;
};

class SumoBridge {
public:
    static SumoEnvironment detect();
    static void export_bundle(const Scenario&, const std::filesystem::path& directory);
    static bool build_network(const std::filesystem::path& directory, const SumoEnvironment&, std::string& error_out);
    static nlohmann::json simulate(const Scenario&, const std::filesystem::path& directory,
                                   std::uint32_t begin_s = 0, std::uint32_t end_s = 3600,
                                   const SumoEnvironment* env_override = nullptr);
};
```

## Detection

For each of `sumo` and `netconvert`, the first of these that exists is used:

1. `$SUMO_HOME/bin/<tool>`
2. `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/app/bin`
3. `command -v <tool>`

A tool counts only if `<tool> --version` exits with status 0. A binary that
exists but cannot start (a missing shared library, the wrong architecture) is
reported unavailable rather than failing later. `sumo_home` is `$SUMO_HOME`
when set, otherwise the parent of the directory holding `sumo`.
`GET /api/v1/system/info` reports the result under `sumo`.

## The bundle

`export_bundle(scenario, dir)` writes:

| File | Contents |
|---|---|
| `network.nod.xml` | One node per DSTNS node at its true-metre position; `traffic_light` where DSTNS has a controller, `priority` otherwise |
| `network.edg.xml` | One edge per traversable DSTNS edge, with its lane count and free speed. `synthetic_reverse` edges are omitted, so OSM one-way restrictions hold in SUMO |
| `sandbox.rou.xml` | Vehicle types and the compiler's planned trips as explicit routes |
| `sandbox.add.xml` | Bus stops on their edges |
| `sandbox.sumocfg` | The configuration tying them together |

## Running SUMO

`simulate(scenario, dir, begin_s, end_s)`:

1. Detects SUMO, unless an environment is passed in, and fails if unavailable.
2. Writes the bundle.
3. Deletes any old `network.net.xml`, then runs `netconvert` on the node and
   edge files. It fails if `netconvert` exits non-zero or writes no network.
4. Runs `sumo -c sandbox.sumocfg --begin B --end E --seed S --tripinfo-output
   tripinfo.xml`, where `S` is the low 31 bits of the scenario seed, so a SUMO
   run is reproducible too. It fails if `sumo` exits non-zero.
5. Parses `tripinfo.xml` into the vehicle count and the mean travel time,
   waiting time, time loss and route length.

Every path passed to these commands is single-quoted for the shell; the
directory comes from an API request body.

## Over HTTP

| Route | Body | Result |
|---|---|---|
| `POST /api/v1/export/sumo` | `{"directory": "data/sumo_export"}` | The bundle, without running SUMO |
| `POST /api/v1/system/sumo-simulate` | `{"directory": "data/sumo_run", "begin_s": 0, "end_s": 3600}` | Bundle, network, SUMO run and statistics |

`begin_s` and `end_s` are virtual-day seconds with `begin_s < end_s <= 86400`.
Both need an active run (409 otherwise). The engine copies the scenario and
runs SUMO without holding its lock, so playback and the rest of the API carry
on during a long SUMO run.

```json
{
  "ok": true, "engine": "SUMO", "version": "v1_27_1+0354-22511947e85",
  "simulation_period": { "begin_s": 0, "end_s": 1800 },
  "vehicles_simulated": 412,
  "mean_travel_time_s": 183.4, "mean_waiting_time_s": 21.7,
  "mean_time_loss_s": 48.2, "mean_route_length_m": 1611.9,
  "bundle_directory": "/…/sumo_run", "tripinfo_file": "/…/sumo_run/tripinfo.xml"
}
```

## From the CLI

`./launcher sumo` runs the same pipeline outside the server into
`data/sumo_live_run/`, and `./launcher test sumo` runs
`tests/integration/sumo_smoke.sh`. See [Operator CLI](../operator-cli.md).

## Limits

- No libsumo or TraCI coupling: SUMO is a batch process, and its vehicles never
  appear in the observer.
- Signal programmes are left to `netconvert`'s defaults; DSTNS's own timing
  plans and green waves are not exported.
- Weather, flooding, incidents and operator overrides are not exported.
