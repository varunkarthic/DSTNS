# Glossary

ASB
:   **Adaptive Simulation Backpressure.** Slows the simulation, then simplifies
    and finally suspends the interface, when the observer cannot keep up. See
    [Adaptive backpressure](concepts/backpressure.md).

Aggregate model
:   DSTNS models flows and queues per directed road segment, not individual
    vehicles. Compare *microscopic* (SUMO).

Anchor
:   The point inside a city, chosen by the seed, that a district grows from.

Base rate
:   Virtual seconds per wall-clock second at 1×: 86,400 divided by the playback
    duration. With a one-hour day it is 24.

Checkpoint
:   A stored copy of the network's dynamic state, every 900 virtual seconds,
    used to seek backwards exactly.

Config revision
:   A counter that increments whenever a control changes the run's
    configuration (speed, modules, overrides).

Congestion
:   Per edge, a number in [0, 1] combining speed loss, queueing and occupancy.
    The network index is its length-weighted, smoothed mean.

CRFG
:   **Connected Radial Frontier Growth.** Grows a connected district outward
    from the anchor along real road distance. See [OSM map
    generation](concepts/osm-map-generation.md#growing-the-district-crfg).

DRNCP
:   Deterministic, canonical, 0-indexed renumbering of the district's nodes by
    OSM ID, so the same map and seed always give the same IDs.

District
:   The connected part of a city's road network a run simulates, about 3,000
    junctions by default.

DWS
:   **Deterministic Weather Simulation.** Scheduled storms with Wendland C²
    kernels, rain and flooding. See [Weather and flooding](concepts/weather.md).

Edge
:   One direction of a road segment between two junctions. Every segment has
    two edges, twins of each other.

Envelope
:   The common wrapper of every read view: run ID, seed, revisions, clock and
    data.

Extract
:   The square of OpenStreetMap data downloaded for a city, shared by all its
    districts.

Lifecycle
:   The run's state: `IDLE`, `PREPARING`, `READY`, `RUNNING`, `PAUSED`,
    `SEEKING`, `STOPPED`, `COMPLETED`, `TERMINATING`.

Observer
:   The browser interface. It watches the run; the CLI decides what runs.

Operator credential
:   The random token the server writes to `logs/operator.token`, required to
    start a run.

Place
:   A mapped feature with a role in demand: a school, office, shop, stop and so
    on.

Playback duration
:   Wall-clock seconds one virtual day takes at 1×, 60 to 3600.

Playback revision
:   A counter that increments on every lifecycle change; used to guard
    automated play and pause.

Run ID
:   `run_` followed by 12 hex digits of the scenario hash. The same seed and
    configuration give the same run ID.

Scenario
:   Everything compiled from a seed and configuration before the clock starts:
    graph, signals, stops, trips, weather, incidents, hashes.

Seed
:   The 128-bit number that names a run and determines everything in it.

State revision
:   A counter that increments with every physics commit.

Sub-seed
:   A seed derived from the master seed for one subsystem with SHA-256, so
    subsystems never share random streams.

Synthetic reverse
:   The reverse edge of a one-way road, kept for topology but never used for
    traffic, routing or SUMO.

Tick rate
:   The speed multiplier, more than 0 and at most 5.

Virtual day
:   The 86,400 simulated seconds of one run, from 00:00:00 to 24:00:00.

Wendland C²
:   The compactly supported kernel \( (1-q)^4 (1+4q) \) used for rain fields.
