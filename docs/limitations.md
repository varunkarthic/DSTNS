# Known limitations

Behaviour that is understood and accepted rather than defective. Each entry says what
the limitation is, why it exists, what it affects, and how to work around it. Read it
before relying on DSTNS for a purpose it was not designed for. The modelling
assumptions behind several of these are explained in
[Model scope and assumptions](concepts/model-scope.md).

## Modelling

### The live model is aggregate

**What.** The engine models flows, speeds and queues per directed road segment. It
does not track individual vehicles, lanes, turning movements or signal conflict
geometry.

**Why.** An aggregate model lets a whole day of a 3,000-junction district be seeked
backwards and forwards interactively, which a microscopic model cannot do at that
cost.

**Effect.** The moving dots on the map are representative samples of each road's
modelled count and speed, not tracked vehicles; there are no vehicle IDs or
trajectories. Turn-level effects, such as a blocked left-turn bay, are not
represented.

**Workaround.** Export the scenario to [SUMO](components/sumo-adapter.md) for a
microscopic batch run of the same network.

### The model is not calibrated

**What.** Demand profiles, signal timings, weather intensities and incident rates are
plausible, documented parameters, not values fitted to measurements of any real city.

**Effect.** Results are internally consistent and exactly reproducible, but they are
not a forecast of real traffic in the city a seed selects. DSTNS has no
certification for operational traffic control.

**Workaround.** Use DSTNS for comparative experiments, algorithm integration,
teaching and demonstration, and say so when reporting results. The parameters are
listed in full in the [Mathematical model](concepts/mathematical-model.md).

### Signals are a two-group approximation

**What.** Each controller alternates two approach groups (north-south and east-west)
with a six-phase plan. Green splits are proportional to arriving road capacity, not
to measured turning demand. Plans are fixed for the run; there is no actuation.

**Effect.** Junctions with more than two approach directions, or with dedicated turn
phases, are simplified. Offsets are computed from each junction's distance to the
centre of the signalised area, which coordinates corridors that radiate from it best.

See [Traffic signals](concepts/signals.md).

### Routing assumes a maximum speed

**What.** The A* heuristic divides straight-line distance by 33.33 m/s (120 km/h).

**Effect.** An operator speed multiplier above about 1.1 on a motorway exceeds that
speed, making the heuristic inadmissible. Routes may then be slightly longer than
optimal. They are always valid routes.

## Maps

### OpenStreetMap XML only

**What.** The loader reads OpenStreetMap XML as Overpass and the openstreetmap.org
export produce it. PBF files and planet-scale indexing are not supported.

**Workaround.** Convert a PBF extract with `osmium cat extract.osm.pbf -o extract.osm`
and pin it with `--osm-file`.

### Multipolygon relations are not assembled

**What.** Complete simple ways and point features are kept. Multipolygon relations,
and the inner rings (holes) that they describe, are not assembled.

**Effect.** A building or area mapped only as a multipolygon may be missing or have an
incomplete footprint. DSTNS leaves it out rather than inventing geometry. Road ways
are unaffected.

### Self-closing ways

**What.** The XML tokenizer expects every `<way>` to have a closing `</way>`. A
self-closing `<way … />` would be paired with the next way's closing tag.

**Effect.** None in practice: Overpass and the openstreetmap.org export never emit
self-closing ways for road queries. Hand-edited files should use the long form.

### A seed alone does not pin upstream map data

**What.** A seed chooses a city and a district inside it, but OpenStreetMap is edited
continuously. The same seed downloaded a year apart can produce a different graph.

**Workaround.** Keep the cached extract, or use a [saved seed](guide/saved-seeds.md),
which stores a copy of the map bytes and refuses to run if they change. See
[Reproducibility](concepts/reproducibility.md).

### No substitute map

**What.** When a seed's city cannot be downloaded, the run fails with
`MAP_FETCH_FAILED`. No other map is substituted.

**Why.** Substituting a map would make the same seed mean different places on
different days. Failing is the only behaviour that keeps a seed meaningful.

**Workaround.** Run a cached city or the bundled district offline. See
[Seeds and places](guide/seeds-and-places.md#the-map-cache).

## Operation

### One simulation per server

**What.** A server process holds one run at a time.

**Workaround.** Run several servers on different ports with different `--logs`
directories, or several containers with different `DSTNS_HOST_PORT` values and
Compose project names.

### No user accounts

**What.** There are no users, roles or tenants. The operator credential controls only
which client may start or prepare a run; any client that can reach the API can
watch, pause, seek and change the running world.

**Workaround.** Keep the default loopback bind, or put an authenticating reverse proxy
in front. See [Deployment security](deployment/security.md).

### Operator edits are not part of the replay journal

**What.** Operator world changes (road overrides, signal toggles, manual rain, module
switches and surges) take effect from the moment they are applied. All but surges can
be undone and redone, but none is recorded in a time-indexed journal that checkpoints
replay.

**Effect.** Exact replay is guaranteed for a fixed start-up configuration, the
engine's scheduled events and playback controls. Reproducing a run that included
operator edits requires repeating the same edits at the same virtual times. The
observer exposes none of these world-changing controls; they are available only
through the [Control API](api/control-api.md).

### GPU acceleration helps only large worlds

**What.** Every simulated second returns to the CPU, because events and demand
couplings read the step's results. A GPU step therefore pays a fixed cost of about
half a millisecond, and the 64-bit integer arithmetic that makes it bit-identical is
emulated on GPUs.

**Effect.** District-sized worlds run faster on the CPU, and `auto` keeps them there.
On an Apple M4 the GPU wins from about 50,000 junctions, by 1.2 to 1.5 times; see
[Performance](deployment/performance.md#compute-backends).

**Workaround.** None needed: the choice is automatic and does not change results.
Batched grid workloads, which stay on the GPU between iterations, gain far more.

### Cross-platform results depend on the C library's sin and exp

**What.** The physics step is integer arithmetic, identical everywhere, but the demand
schedule and the storm and surge curves are computed in floating point on the CPU.
C libraries may round `sin` and `exp` differently in the last bit.

**Effect.** Runs are identical on one platform and toolchain. Across platforms they
are expected to be identical (macOS and Linux agreed on every node and edge across a
full day), but a last-bit difference that straddles a quantisation boundary could
diverge them. See [Reproducibility](concepts/reproducibility.md#floating-point-caveat).

### SUMO endpoints write where they are told

**What.** `POST /api/v1/export/sumo` and `POST /api/v1/system/sumo-simulate` write to
the `directory` given in the request body. Every argument passed to a shell is
quoted, so the path cannot inject commands, but the endpoints are not confined to one
directory.

**Workaround.** These are operator tools for a local server. Do not expose the API to
untrusted clients; see [Deployment security](deployment/security.md).

### The CLI health checks use loopback

**What.** The operator CLI binds the server to `api.host` but always checks its health
on `127.0.0.1`.

**Effect.** If `api.host` names a specific non-loopback interface, the CLI cannot reach
its own server. `0.0.0.0` and `127.0.0.1` both work.

### Event history is bounded

**What.** The engine keeps the last 2,000 executed events and an all-time count, not
a complete archive. Event queue pages are limited to 200 rows (the observer requests
30).

**Workaround.** Record what you need as it happens, from
`/api/v1/view/event-queue?view=history` or the SQLite journal in `logs/runtime.db`. See [Logging](deployment/logging.md).

## Platforms

### No native Windows build

**What.** The core uses POSIX process APIs (`posix_spawn`, `popen`, process groups).

**Workaround.** Use WSL 2 or Docker Desktop. See
[System requirements](getting-started/requirements.md).

### Floating-point results across architectures

**What.** Results are reproducible bit for bit on one platform and toolchain.
Different CPUs, compilers or optimisation flags may differ in the last bits of
floating-point arithmetic.

**Effect.** Continuous integration asserts exact equality on the platforms it runs.
When comparing results across very different toolchains, compare the hashes of the
compiled scenario first, then the runtime state. See
[Reproducibility: floating-point caveat](concepts/reproducibility.md#floating-point-caveat).
