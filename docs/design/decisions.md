# Design decisions

The significant decisions that shape DSTNS, each recorded with the problem it
answers, the decision taken, and its consequences. Read this to understand *why* the
system behaves as it does. The [design specifications](index.md) record the original
intent; this page records the decisions as implemented.

| # | Decision | Area |
|---|---|---|
| [1](#1-the-core-is-the-single-authority) | The core is the single authority | Architecture |
| [2](#2-the-seed-is-the-identity-of-a-run) | The seed is the identity of a run | Determinism |
| [3](#3-counter-based-random-numbers-per-subsystem) | Counter-based random numbers per subsystem | Determinism |
| [4](#4-fixed-one-second-physics) | Fixed one-second physics | Engine |
| [5](#5-checkpoints-and-replay-for-time-travel) | Checkpoints and replay for time travel | Engine |
| [6](#6-an-aggregate-live-model-with-sumo-as-a-batch-adapter) | An aggregate live model, with SUMO as a batch adapter | Modelling |
| [7](#7-one-download-per-city-many-districts) | One download per city, many districts | Maps |
| [8](#8-no-fallback-map) | No fallback map | Maps |
| [9](#9-missing-map-data-is-left-out-not-invented) | Missing map data is left out, not invented | Maps |
| [10](#10-signals-snapped-to-junctions-and-coordinated) | Signals snapped to junctions and coordinated | Modelling |
| [11](#11-a-heap-of-pending-events) | A heap of pending events | Engine |
| [12](#12-the-observer-polls-and-reports-its-lag) | The observer polls and reports its lag | Observer |
| [13](#13-backpressure-governs-pacing-never-results) | Backpressure governs pacing, never results | Observer |
| [14](#14-presentation-stays-in-the-browser) | Presentation stays in the browser | Observer |
| [15](#15-only-the-operator-starts-runs) | Only the operator starts runs | Security |
| [16](#16-local-by-default) | Local by default | Security |
| [17](#17-verify-the-machine-before-starting) | Verify the machine before starting | Operations |
| [18](#18-the-physics-step-is-integer-fixed-point-written-once) | The physics step is integer fixed point, written once | Compute |
| [19](#19-the-gpu-is-an-optimisation-chosen-by-measurement) | The GPU is an optimisation, chosen by measurement | Compute |
| [20](#20-recover-from-a-lost-gpu-by-replaying-a-journal) | Recover from a lost GPU by replaying a journal | Compute |
| [21](#21-vulkan-loaded-at-run-time-nothing-vendor-specific) | Vulkan, loaded at run time; nothing vendor-specific | Compute |

## 1. The core is the single authority

**Problem.** A simulation watched by a browser and driven by a CLI can end up with
three copies of the truth that drift apart.

**Decision.** All simulation state lives in one C++ process. The CLI decides *what*
runs (seed, map, day type, duration, speed). The observer decides only *how it is
watched*, plus playback, speed and requesting a new world. Neither keeps simulation
state of its own; both read what the core publishes, versioned by `run_id` and
`state_revision`.

**Consequences.** Any client sees the same state. The observer can reload at any time
without losing anything. Every read of state takes one mutex, so a response always
describes a single instant.

## 2. The seed is the identity of a run

**Problem.** A run should be nameable, shareable and repeatable with as little as
possible.

**Decision.** One number, the seed, determines the city, the district, the signals,
the demand, the weather and the incidents. The seed is displayed exactly as typed.
The mapping from seed to place (the catalogue of 181 cities and its order) is frozen
under a version name, `urban-crfg-v3`, and saved configurations from any other version
are refused rather than reinterpreted.

**Consequences.** Sharing a run means sharing a number. Changing the catalogue would
silently move every saved seed, so it can only change under a new version name.

## 3. Counter-based random numbers per subsystem

**Problem.** With one sequential random stream, adding a single draw in one subsystem
shifts every later draw everywhere else, and results change for reasons unrelated to
the change.

**Decision.** Each subsystem derives its own sub-seed from the master seed with
SHA-256 and a fixed label, and draws from a counter-based generator (Philox 4×32-10)
addressed by `(domain, object, purpose, draw)`. A random value is a pure function of
its address.

**Consequences.** Subsystems are independent: changing the weather code cannot move a
single incident. Values can be computed in any order, so parallel or lazy evaluation
never changes results. See [Deterministic seeding](../concepts/deterministic-seeding.md).

## 4. Fixed one-second physics

**Problem.** If the physics step depended on frame rate or playback speed, watching
faster would change what happens.

**Decision.** Physics always advances in steps of exactly one virtual second.
Playback speed only changes how many steps are taken per wall-clock second. Every
rate change, pause, play or seek first catches up to the wall clock and then
re-anchors it.

**Consequences.** Results are independent of speed, of the machine's load and of
whether anyone is watching. Stepping, seeking and playing to the same time give
identical state.

## 5. Checkpoints and replay for time travel

**Problem.** Operators want to scrub backwards through the day, but the model cannot
be run in reverse.

**Decision.** Every 900 virtual seconds the engine stores a checkpoint of all dynamic
state: roads, junctions, signals, demand, the event heap, recent history and the
congestion tracker. Seeking backwards restores the nearest earlier checkpoint and
replays forward in one-second steps.

**Consequences.** Seeking is exact, never approximate, and costs at most 899 replayed
seconds (about 0.3 s for a typical district). Checkpoints are most of the server's
memory use. Operator edits are not in the replay journal; see
[Known limitations](../limitations.md#operator-edits-are-not-part-of-the-replay-journal).

## 6. An aggregate live model, with SUMO as a batch adapter

**Problem.** A microscopic model is the most realistic, but it cannot simulate a
whole day of a city district fast enough to scrub through interactively.

**Decision.** The live engine models aggregate flows, speeds and queues per directed
road segment. Eclipse SUMO is supported as a separate batch adapter: the same scenario
is exported and run microscopically on request, and SUMO's results never feed back
into the live model.

**Consequences.** A 3,000-junction day runs thousands of times faster than real time.
Vehicle dots on the map are representative samples of modelled flow, not tracked
vehicles, and the documentation says so wherever it matters.

## 7. One download per city, many districts

**Problem.** Downloading a fresh map for every seed is slow and burdens the public
Overpass service.

**Decision.** The unit of download is a city extract, a square of 5 km by default,
cached under a name that depends only on the city. The seed's anchor then chooses
where in the extract the district grows. The server sweeps the cache once at start-up
and keeps the newest extracts.

**Consequences.** Re-rolling usually lands in an already downloaded city and costs
nothing; only a new city triggers a download. A long-lived installation cannot
accumulate one extract per city it has ever visited.

## 8. No fallback map

**Problem.** When a download fails, substituting a bundled map would let the run
continue.

**Decision.** A failed download fails the run with `MAP_FETCH_FAILED`, naming the
city, the coordinates and the cause. Nothing is substituted. The CLI lists maps
already on disk and the command to run one offline.

**Consequences.** A seed means the same place every time it runs. Offline use is
explicit: pin a cached extract or the bundled district.

## 9. Missing map data is left out, not invented

**Problem.** OpenStreetMap is incomplete: some buildings exist only as multipolygon
relations, some places have no name, some roads have no direction tag.

**Decision.** DSTNS reproduces the map faithfully. Features that cannot be assembled
completely are left out; unnamed features are described by their kind ("School",
"Service road"); defaults for missing tags follow OpenStreetMap conventions, such as
roundabouts being one-way.

**Consequences.** Nothing on the map is fictional. Some footprints are missing where
the source has only relations; see [Known limitations](../limitations.md#multipolygon-relations-are-not-assembled).

## 10. Signals snapped to junctions and coordinated

**Problem.** OpenStreetMap tags signals on the stop line of an approach, not on the
junction. Taken literally, controllers appear in the middle of roads; random offsets
make neighbouring signals flicker independently.

**Decision.** Each tagged node is snapped to the nearest junction within 45 metres,
collapsing several approaches into one controller. Offsets are the travel time at
50 km/h from the centre of the signalised area, so neighbouring signals turn green in
sequence.

**Consequences.** Controllers stand where a traffic engineer would expect them, and
corridors show green waves. See [Traffic signals](../concepts/signals.md).

## 11. A heap of pending events

**Problem.** Thousands of signal controllers each change phase every few seconds;
scanning them all every second does not scale, and polling-based scheduling would
make correctness depend on timing.

**Decision.** The event runtime is a binary min-heap ordered by
`(virtual second, sequence)`, holding exactly one pending transition per controller.
Executing a transition inserts its successor.

**Consequences.** Each transition costs \(O(\log n)\), and 10,000 controllers are part
of the test suite. Ties are broken by insertion sequence, so the order of execution
is deterministic.

## 12. The observer polls and reports its lag

**Problem.** A server-sent stream pushes data at the server's pace, whether or not
the browser can keep up.

**Decision.** The observer polls status, then the snapshot and news, one request at
a time, and fetches topology only when the run changes. It reports how far behind it
is. Server-sent event streams remain available for other clients.

**Consequences.** The observer can never be flooded, and the server knows when it is
behind; see the next decision.

## 13. Backpressure governs pacing, never results

**Problem.** In a background tab, a virtual machine or a slow laptop, the browser
falls behind the simulation, and what it shows becomes misleading.

**Decision.** Adaptive Simulation Backpressure scores the observer's lag and frame
time and, through a ladder of states, lowers the speed ceiling, turns off motion and
expensive layers, and finally suspends the interface until it catches up. It changes
only pacing and presentation.

**Consequences.** What the observer shows is always current. Results are unaffected,
because physics steps are fixed. See [Adaptive backpressure](../concepts/backpressure.md).

## 14. Presentation stays in the browser

**Problem.** If layer toggles or notification settings reached the core, one viewer's
preferences would change what everyone sees.

**Decision.** Display layers, place names, clock format, reduced motion, Do Not
Disturb, Auto Focus, pan and zoom are local to the browser. Preferences are stored as
differences from the operator's defaults, so a later change to the defaults still
reaches every setting a viewer never touched. A test records every request the
observer sends and asserts that none results from these controls.

**Consequences.** Viewers cannot disturb a run by changing how they watch it.

## 15. Only the operator starts runs

**Problem.** A browser that can choose the seed and the map can be made, by any page
it visits, to start an arbitrary run.

**Decision.** Starting or preparing a run requires a credential that the server
writes to `logs/operator.token` with owner-only permissions. The CLI reads it; the
observer never has it. The observer can request a *new* world, whose seed comes from
a secure generator, and operators can disable even that.

**Consequences.** What runs is always the operator's decision. Scripts that start runs
send the credential explicitly; see [Security](../deployment/security.md).

## 16. Local by default

**Problem.** The API can drive a run and write files, and has no user accounts.

**Decision.** The server binds to `127.0.0.1` unless told otherwise. On loopback it
refuses unknown `Host` names, it grants CORS only to its own origin and to configured
origins, and it refuses cross-site state changes. Shutdown is `POST` only.

**Consequences.** A default installation cannot be reached from the network or driven
by a web page. Exposing it is a deliberate act; see
[Deployment security](../deployment/security.md).

## 17. Verify the machine before starting

**Problem.** "It passed in CI" says nothing about whether this machine can run a
simulation.

**Decision.** Every `./launcher start` runs a sequence of checks in increasing cost:
platform, Node.js, Python, configuration files, the map fetcher, the cache directory,
the core binary and its version, the freshness of the observer bundle, the API port,
and the fast test suites. A failure stops start-up and names what failed; a warning
continues and says what is reduced.

**Consequences.** "Ready" is a statement about this machine. The check costs seconds
and catches broken toolchains before a run does. See
[Installation: start-up checks](../getting-started/installation.md#start-up-checks).

## 18. The physics step is integer fixed point, written once

**Problem.** A GPU should compute the same state as the CPU, or a run's results would
depend on the hardware that computed them. Floating point cannot promise that: drivers
fuse, reorder and flush operations differently from one vendor, driver and compiler
version to the next. And a GPU kernel maintained by hand beside the CPU code drifts.

**Decision.** The per-node and per-edge step is integer fixed point (Q30 fractions, Q16
speeds and vehicles, Q8 flows, 1/256 m positions). It is written once, in
`shaders/include/dstns_physics.h`, in the intersection of C++ and GLSL, and compiled
into both the CPU backend and the shaders. Reductions are integer sums. Anything that
needs a transcendental function runs on the CPU, once per step.

**Consequences.** Every backend computes the same bits, and the test suites require
it. The backend enters no hash. Results moved by about 10⁻⁷ from 2.1.0's
double-precision model, a change of representation, not of model. The CPU path is as
fast as before. GPUs pay for 64-bit integer arithmetic, which they emulate. See
[Compute architecture](../concepts/compute.md).

## 19. The GPU is an optimisation, chosen by measurement

**Problem.** A GPU step costs a submission and a wait before it does any work, and
every simulated second must return to the host for events and demand. For the
district-sized worlds DSTNS usually runs, the CPU is faster.

**Decision.** `auto` keeps worlds below measured thresholds on the CPU and, above
them, times both backends on the world itself and keeps the faster. A GPU is used only
after a self-test dispatch returns the right answer. A missing or failed GPU is never
an error unless the operator required one.

**Consequences.** Nobody needs to know which backend suits their machine.
Because both compute the same state, choosing at run time costs nothing in
reproducibility. See [Performance](../deployment/performance.md#compute-backends).

## 20. Recover from a lost GPU by replaying a journal

**Problem.** When a device is lost, its memory, and the simulation state in it, is
gone. Restoring the last checkpoint and replaying is not exact: operator controls are
standing inputs, so a road closed after the checkpoint would apply from the
checkpoint onward.

**Decision.** Each step computes into a separate candidate buffer, so a failed step
leaves the committed state intact when the device survives. While a GPU runs, the
dispatcher keeps the last complete host copy of the state (from every checkpoint,
download, or at least every 300 steps) and a journal of the exact input words each
step used since. After a device loss it replays the journal on the CPU.

**Consequences.** Recovery is exact, operator actions included, and invisible to the
engine and the API. The journal and the periodic copy cost a few percent of the step's
transfers. The checkpoint replay remains as a last resort.

## 21. Vulkan, loaded at run time; nothing vendor-specific

**Problem.** DSTNS must accelerate on NVIDIA, AMD, Intel and Apple hardware, build
without a vendor SDK, and run on machines with no GPU.

**Decision.** Vulkan 1.2 compute, loaded at run time through volk (MoltenVK on
macOS), with pinned headers fetched at build time and SPIR-V compiled at build time
and committed for machines without a compiler. No CUDA, and no vendor extension is
required. Device selection is by score and UUID, never by index 0.

**Consequences.** One binary runs everywhere, accelerated where it can be. Vulkan code
is confined to `src/vulkan/`. The observer's Canvas rendering is untouched; any GPU
rendering in the browser would be a separate WebGPU project.
