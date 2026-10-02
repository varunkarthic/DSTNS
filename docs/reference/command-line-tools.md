# Command-line tools

Every executable the build produces, with its arguments, what it prints and when
to use it. The operator CLI (`./launcher`) is documented separately in
[Operator CLI](../guide/operator-cli.md); this page covers the programs it drives.

| Program | Purpose | Needs a running server |
|---|---|---|
| [`dstns_server`](#dstns_server) | The engine, the HTTP API and the observer on one port | n/a |
| [`dstns_scenario_export`](#dstns_scenario_export) | Compile a synthetic-grid scenario and write a SUMO bundle | No |
| [`dstns_replay_verify`](#dstns_replay_verify) | Prove that one seed gives identical worlds twice | No |
| [`dstns_road_index`](#dstns_road_index) | Compile an OSM file and print its graph and scenario hashes | No |
| [`dstns_benchmark`](#dstns_benchmark) | Time compilation, A* routing and snapshots on a synthetic grid | No |
| `scripts/fetch_osm.py` | Download one city extract from an Overpass endpoint | No |

All binaries are written to `build/` by `cmake --build build -j`. See
[Building from source](../development/building.md).

## dstns_server

```text
dstns_server [--host ADDR] [--port PORT] [--logs DIR] [--maps DIR]
             [--map-cache keep|prune|clear] [--map-cache-keep N]
             [--compute auto|cpu|vulkan] [--gpu-device auto|INDEX|UUID|NAME]
             [--allow-software-vulkan] [--require-vulkan] [--compute-verify]
             [--vulkan-validation] [--compute-cache DIR] [--gpu-diagnostics]
             [--version]
```

| Flag | Default | Meaning |
|---|---|---|
| `--host ADDR` | `127.0.0.1` | Address to bind. Loopback by default; `0.0.0.0` exposes the API to the network (see [Deployment security](../deployment/security.md)) |
| `--port PORT` | `8090` | TCP port, an integer in [1, 65535]. Out-of-range values are rejected, not wrapped |
| `--logs DIR` | `logs` | Directory for `system.log`, `runtime.db`, `global_view.json` and `operator.token`. Created if missing |
| `--maps DIR` | `data/maps` | Directory holding cached city extracts |
| `--map-cache POLICY` | `prune` | What the start-up sweep does with cached extracts: `keep` leaves all, `prune` removes all but the newest N, `clear` removes all |
| `--map-cache-keep N` | `1` | Extracts `prune` keeps. The container sets 3 |
| `--compute BACKEND` | `auto` | Where the physics runs: `auto`, `cpu` or `vulkan`; see [GPU acceleration](../guide/gpu-acceleration.md) |
| `--gpu-device SPEC` | `auto` | The GPU, by enumeration index, UUID or part of its name |
| `--allow-software-vulkan` | off | Allow CPU implementations of Vulkan such as llvmpipe |
| `--require-vulkan` | off | With `--compute vulkan`, exit at start-up if no GPU can run the step |
| `--compute-verify` | off | Recompute every GPU step on the CPU and compare (diagnosis; slow) |
| `--vulkan-validation` | off | Enable the Khronos validation layers, when installed |
| `--compute-cache DIR` | `data/cache/vulkan` | Pipeline cache directory; an empty value disables it |
| `--gpu-diagnostics` | | Test every Vulkan device (bring-up, pipelines, a dispatch and a checked readback), print the report as JSON and exit: 0 if a device is usable, 3 if the simulation would run on the CPU |
| `--version` | | Print the version and licence notice, then exit |
| `--help` | | Print the synopsis, then exit |

Compute flags override the `DSTNS_COMPUTE_*`, `DSTNS_GPU_*` and `DSTNS_VULKAN_*`
[environment variables](environment-variables.md#compute), which override the
built-in defaults. At start-up the server brings up the selected GPU, so that
`/api/v1/system/info` can report it from the first request.

An unknown argument stops the server with a message and a non-zero exit code.

At start-up the server writes a fresh operator credential to
`<logs>/operator.token` with mode `0600` (or uses `DSTNS_OPERATOR_TOKEN` when set),
sweeps the map cache, then listens. It handles `SIGINT` and `SIGTERM` by shutting
down cleanly; `POST /api/v1/system/terminate` does the same from the API.

```bash
./build/dstns_server --version
./build/dstns_server --port 9000 --logs /tmp/dstns-logs --map-cache keep
```

!!! warning "Starting runs by hand"
    Starting or preparing a run requires the operator credential. Use
    `./launcher`, or send the `X-DSTNS-Operator` header yourself as shown in the
    [API examples](../api/examples.md).

## dstns_scenario_export

Compiles a scenario on a synthetic grid and writes a bundle SUMO can run, without
starting a server. It takes no map file: to export a real city, use
`POST /api/v1/export/sumo` on a running server. It is the program behind
`./launcher sumo`. See also the [SUMO adapter](../components/sumo-adapter.md).

```text
dstns_scenario_export [options] [OUT_DIR]
  --out, --export-sumo DIR   Output directory for the SUMO bundle
  --seed SEED                Hex or integer seed
  --grid WxH                 Synthetic grid dimensions
  --duration SECONDS         Playback duration seconds
  --dws FREQUENCY            Weather event count
```

```bash
# A deterministic 10x10 synthetic grid, exported for SUMO
./build/dstns_scenario_export --seed 382923 --grid 10x10 --duration 600 --dws 4 /tmp/dstns-sumo
```

`OUT_DIR` may be given with `--out` or as the single positional argument.

## dstns_replay_verify

The reproducibility check. It compiles and runs one seed **twice**, on a synthetic
grid and on a bundled OpenStreetMap district, and fails unless every hash and the
full runtime snapshot at 03:25:45 (12,345 virtual seconds) are identical.

```text
dstns_replay_verify [SEED]
```

`SEED` is decimal, as the observer shows it, or `0x` hexadecimal. With no argument
a fixed default is used.

```bash
./build/dstns_replay_verify 382923
```

```text
Replay Verification Tool
Seed: 0x...
PASS [grid]: graph, scenario, event, and full runtime snapshot matched.
PASS [osm]: graph, scenario, event, and full runtime snapshot matched.
```

A mismatch raises an error naming the first quantity that differed and exits with
a non-zero status, which is what continuous integration relies on. Run it from the
repository root: the OSM case reads `tests/fixtures/roads.osm.xml` by a relative
path. The theory is in [Reproducibility](../concepts/reproducibility.md).

## dstns_road_index

Compiles an OpenStreetMap XML file and prints the resulting graph, so you can
check what a map produces and compare hashes between machines.

```text
dstns_road_index <osm_file.xml> [max_nodes]
```

| Argument | Default | Meaning |
|---|---|---|
| `osm_file.xml` | required | An OSM XML file (a cached extract, or `data/fixtures/real_network.osm.xml`) |
| `max_nodes` | `50000` | Upper bound on graph size |

```bash
./build/dstns_road_index data/fixtures/real_network.osm.xml 3000
```

```text
Loading OSM Road Network from: data/fixtures/real_network.osm.xml (max_nodes=3000)
Canonical Nodes: ...
Canonical Edges: ...
Graph Hash:      ...
Scenario Hash:   ...
Road Indexing complete.
```

The hashes are computed with a fixed seed, so they depend only on the file and
`max_nodes`. Equal hashes on two machines mean the same canonical graph. A file
that cannot be read or parsed prints `Error indexing OSM file: ...` and exits with
status 1. Running it without arguments prints the usage line and exits with 1.

## dstns_benchmark

A rough performance probe on a synthetic square grid, with a fixed seed.

```text
dstns_benchmark [GRID_DIM]
```

`GRID_DIM` is the side of the grid and defaults to 20 (400 nodes). The program
prints the node and edge counts and how long compiling took, then the cost of 1,000 A* routes and of 100 dynamic snapshots.
Use it to compare two builds on one machine, not to compare machines; for what the
numbers mean see [Performance](../deployment/performance.md).

```bash
./build/dstns_benchmark 40
```

```text
dstns_benchmark compute [--sizes N,N,...] [--device auto|INDEX|NAME]
                        [--replay-steps N] [--day] [--json FILE]
```

Times the physics step on each compute backend (one CPU thread, all of them,
and Vulkan) on synthetic grids of the given junction counts (default 1,000 to
1,000,000): install, one step, 100 steps, a seek replay, the observer's view,
full readback, per-step transfer volumes, GPU pass times, and accelerator
bring-up with a cold and a warm pipeline cache. `--day` adds a full simulated
day through the engine on a 55 × 55 compiled world. It reports the size from
which Vulkan is at least 10% faster; see
[Performance](../deployment/performance.md#compute-backends).

## scripts/fetch_osm.py

The map downloader the server invokes when a seed selects a city that is not
cached. You can also run it yourself to prefetch a city; its options (`--bbox`, `--anchor`,
`--radius-m`, `--output`, `--retries`, `--endpoint`, `--timeout`) are listed by
`python3 scripts/fetch_osm.py --help`. It reads `DSTNS_OVERPASS_ENDPOINTS`, a
comma-separated list of Overpass API endpoints to try in order, and writes the
extract and a `.manifest.json` recording the source, licence, bounding box, byte
count and SHA-256. See [OSM map generation](../concepts/osm-map-generation.md).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | A handled failure: bad arguments, unreadable input, failed verification |
| non-zero, other | A crash or signal; the shell reports the signal number plus 128 |

The test and verification programs are plain executables, so `ctest` and shell
scripts use the exit status directly.
