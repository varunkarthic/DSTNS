# Model scope and assumptions

What DSTNS simulates, at what resolution, under which assumptions, and what it is
suitable for. Read this before drawing conclusions from a run. Specific constraints
and their workarounds are listed in [Known limitations](../limitations.md).

## What is simulated

| Domain | Modelled | Resolution |
|---|---|---|
| Road network | Real OpenStreetMap roads, one-way rules, lane counts and road classes; each class sets a free-flow speed and a capacity | Directed road segment between junctions |
| Time | One virtual day, 00:00:00 to 24:00:00 | One-second physics steps |
| Traffic | Demand, speed, capacity, queues, halting vehicles, occupancy | Aggregate per directed segment |
| Signals | Fixed-time two-group controllers at real signalised junctions | Per junction, per phase |
| Places | Schools, offices, shops, hospitals, parks, stops and other mapped features | Per place, 18 kinds |
| Demand | Daily profiles per kind of place, couplings to conditions, seeded hotspots | Per place, spread to roads within 400 m |
| Weather | Moving, growing and decaying storm cells with smooth rain fields | Per node, continuous in space |
| Flooding | Accumulation and drainage of standing water, road closure when deep | Per node and segment |
| Incidents | Accidents, breakdowns, closures and spills with planned durations | Per segment |
| Public transport | Bus stops placed to realistic spacing and coverage | Stops only; no vehicles |

## What is not simulated

| Not modelled | Consequence |
|---|---|
| Individual vehicles, drivers and their routes through the day | Flow markers are representative samples, not tracked vehicles. Individual trips are planned only for the SUMO export |
| Lanes, turn bays and turning movements | Junction delay is captured through the signal multiplier and queue growth |
| Pedestrians and cyclists | Crossings without a junction are not signals |
| Buses in service, timetables and dwell times | Bus stops affect demand only |
| Parking search, tolls and route choice in response to congestion | Demand is location-based; it is not re-routed by drivers |
| Posted speed limits (`maxspeed` tags) | Free-flow speed comes from the road class |
| Measured calibration data | Parameters are plausible and documented, not fitted to a specific city |

For a microscopic view of the same network, export the scenario to
[SUMO](../components/sumo-adapter.md), which models individual vehicles as a separate
batch run. SUMO results never feed back into the live model.

## Key assumptions

1. **Aggregate flow.** Within a road segment, traffic is described by a load, a mean
   speed and a queue, which relax towards targets set by demand, capacity and
   signals. This is a macroscopic description in the spirit of link performance
   functions.
2. **Speed and capacity are multiplicative.** Signals, rain, flooding, incidents and
   operator overrides each multiply a road's speed and capacity independently. This
   makes every effect separable and explainable on its own.
3. **Demand is driven by places.** Roads carry more traffic near places that are busy
   at that time of day, on top of a network-wide daily profile.
4. **Weather is spatially smooth.** Rain uses a compactly supported kernel, so its
   intensity falls continuously to zero at the edge of a storm and nothing changes
   abruptly.
5. **The map is truth.** Where OpenStreetMap is incomplete or wrong, DSTNS reproduces
   it faithfully rather than guessing. Missing data is left out, never invented.
6. **The seed is the only source of variation.** Every random choice is drawn from the
   seed through a sub-seed for its subsystem. Nothing depends on wall-clock time,
   thread scheduling or the order of hash-table iteration.

## Units and conventions

| Quantity | Unit |
|---|---|
| Time | Virtual seconds since 00:00:00, from 0 to 86,400 |
| Distance | Metres, in a local projection true to scale around the district |
| Speed | Metres per second (`_mps`) |
| Flow and capacity | Vehicles per hour (`_vph`) |
| Congestion | 0 to 1 per road; 0 to 100% for the network index |
| Rain and flood | Normalised intensity, 0 to 1 |
| Coordinates in the API | WGS 84 latitude and longitude, plus projected metres |

## Fitness for purpose

| Use | Suitable | Notes |
|---|---|---|
| Teaching traffic and simulation concepts | Yes | Every effect is visible, explainable and repeatable |
| Comparing algorithms or policies under identical conditions | Yes | The same seed gives the same world, bit for bit |
| Integration testing of software that consumes traffic data | Yes | A documented, versioned HTTP API with realistic dynamics |
| Demonstrations | Yes | Real cities, a polished observer and a PDF report |
| Forecasting traffic in a real city | No | The model is not calibrated against measurements |
| Operational traffic control or safety decisions | No | No validation or certification for that purpose |

When publishing results, state the DSTNS version, the seed, the day type, the map
source and its checksum, and any operator actions, so that others can reproduce
them. See [Reproducibility](reproducibility.md).

## Related

- [Mathematical model](mathematical-model.md): every equation and constant
- [Simulation engine](simulation-engine.md): the physics step in order
- [Known limitations](../limitations.md): specific constraints and workarounds
