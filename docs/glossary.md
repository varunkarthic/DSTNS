# Glossary

Aggregate model
:   DSTNS models flows and queues per directed road segment, not individual
    vehicles. Compare *microscopic* (SUMO).


Anchor
:   The point inside a city, chosen by the seed, that a district grows from.


Approach group
:   The roads entering a signalised junction that share a green: group A runs mainly
    north-south, group B mainly east-west. See [Traffic signals](concepts/signals.md).


ASB
:   **Adaptive Simulation Backpressure.** Slows the simulation, then simplifies
    and finally suspends the interface, when the observer cannot keep up. See
    [Adaptive backpressure](concepts/backpressure.md).


Attraction
:   The share of nearby places' excess demand that falls on one road, capped at 2.
    See [Demand and places](concepts/demand.md).


Base rate
:   Virtual seconds per wall-clock second at 1×: 86,400 divided by the playback
    duration. With a one-hour day it is 24.


Checkpoint
:   A stored copy of the network's dynamic state, every 900 virtual seconds,
    used to seek backwards exactly.


Compute backend
:   What executes the physics step: the CPU (the reference) or Vulkan on a GPU.
    Every backend computes the same state, bit for bit. See
    [Compute architecture](concepts/compute.md).


Compute dispatcher
:   The engine component that owns the run's fixed-point state, chooses the compute
    backend, and moves the state between backends.


Config revision
:   A counter that increments whenever a control changes the run's
    configuration (speed, modules, overrides).


Congestion
:   Per edge, a number in [0, 1] combining speed loss, queueing and occupancy.
    The network index is its mean weighted by length and lanes, reported with a
    15-minute moving average. See [Congestion and road state](concepts/congestion.md).


Congestion index
:   The network's congestion as a percentage: the length-and-lane-weighted mean of
    every road's congestion. See [Congestion and road state](concepts/congestion.md).


Coupling
:   A factor by which a place's demand responds to current conditions, such as
    nearby closures or rain. See [Demand and places](concepts/demand.md#couplings-places-respond-to-the-network).


CRFG
:   **Connected Radial Frontier Growth.** Grows a connected district outward
    from the anchor along real road distance. See [OSM map
    generation](concepts/osm-map-generation.md#growing-the-district-crfg).


District
:   The connected part of a city's road network a run simulates, about 3,000
    junctions by default.


DRNCP
:   Deterministic, canonical, 0-indexed renumbering of the district's nodes by
    OSM ID, so the same map and seed always give the same IDs.


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


Fixed point
:   Representing a real number as an integer count of a fixed fraction: Q30 holds
    fractions in units of 2⁻³⁰, Q16 speeds in units of 2⁻¹⁶ m/s. The physics step is
    fixed point so that every backend computes identical bits.


Green wave
:   Signal offsets timed so that traffic released at one junction reaches the next
    on green. See [Traffic signals](concepts/signals.md#green-waves).


Hotspot
:   One of a small, seeded set of central roads that is permanently more attractive
    to traffic.


Lifecycle
:   The run's state: `IDLE`, `PREPARING`, `READY`, `RUNNING`, `PAUSED`,
    `SEEKING`, `STOPPED`, `COMPLETED`, `TERMINATING`.


Map selection version
:   The name of the seed-to-place algorithm and its city catalogue, currently
    `urban-crfg-v3`. Saved seeds from another version are refused.


MoltenVK
:   A Vulkan implementation on Apple's Metal, through which DSTNS uses Apple GPUs.


Observer
:   The browser interface. It watches the run; the CLI decides what runs.


Operator credential
:   The random token the server writes to `logs/operator.token`, required to
    start a run.


Pinned map
:   A map file given explicitly with `--osm-file`, instead of the city the seed
    would choose.


Place
:   A mapped feature with a role in demand: a school, office, shop, stop and so
    on.


Place kind
:   One of 18 categories (school, office, retail, park…) that decides a place's daily
    demand profile.


Playback duration
:   Wall-clock seconds one virtual day takes at 1×, 60 to 3600.


Playback revision
:   A counter that increments on every lifecycle change; used to guard
    automated play and pause.


Run ID
:   `run_` followed by 12 hex digits of the scenario hash. The same seed and
    configuration give the same run ID.


Saved seed
:   A named, complete run configuration stored by the CLI. See
    [Saved seeds](guide/saved-seeds.md).


Scenario
:   Everything compiled from a seed and configuration before the clock starts:
    graph, signals, stops, trips, weather, incidents, hashes.


Seed
:   The 128-bit number that names a run and determines everything in it.


SPIR-V
:   The binary intermediate form of Vulkan shaders. DSTNS compiles its GLSL compute
    shaders to SPIR-V at build time and embeds them in the binary.


State revision
:   A counter that increments with every physics commit.


Sub-seed
:   A seed derived from the master seed for one subsystem with SHA-256, so
    subsystems never share random streams.


Surge
:   An operator-placed pulse of extra demand around a point, which rises and falls
    over its life.


Synthetic reverse
:   The reverse edge of a one-way road, kept for topology but never used for
    traffic, routing or SUMO.


Tick rate
:   The speed multiplier, more than 0 and at most 5.


Virtual day
:   The 86,400 simulated seconds of one run, from 00:00:00 to 24:00:00.


Vulkan
:   The cross-vendor GPU API DSTNS uses for its GPU backend. See
    [GPU acceleration](guide/gpu-acceleration.md).


Wendland C²
:   The compactly supported kernel \( (1-q)^4 (1+4q) \) used for rain fields.
