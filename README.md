# DSTNS

Deterministic Spatiotemporal Transport Network Simulator (DSTNS) is a C++20 road-network scenario compiler and runtime controller with a separate React/MapLibre operator UI. It makes the seed, topology, schedules, control journal, state revisions, and replay identity explicit. SUMO consumes exported canonical networks for microscopic integration; DSTNS owns scenario semantics.

Developed by Varun Karthic. Version 1.0.0.

## What works

- 128-bit explicit or OS-generated seeds, SHA-256 identities, counter-addressed Philox RNG domains, and stable canonical IDs.
- Offline deterministic fixture generation and road-only OSM XML ingestion with access/highway filtering, bounded seeded region selection, stable numbering, and bidirectional normalization with provenance.
- Immutable topology plus contiguous dynamic state, deterministic A*, graph-spaced bus stops, stop-local buildings, signals, traffic hotspots/trips, compact DWS fields, flood reservoirs, multiplicative weather/traffic coupling, and coherent revisions.
- API-driven playback lifecycle: start, pause, play, stop, reset, checkpoint-backed seek, tick-rate control, module controls, manual weather/traffic overlays, edge overrides, logical undo/redo, news, metrics, logs, and reconnecting SSE snapshots.
- SQLite WAL runtime logs plus human-readable system logs.
- Separate React/TypeScript UI with MapLibre canonical roads, optional OSM tiles, state coloring, controls, inspection and news.
- SUMO plain-XML export verified with `netconvert` and a headless SUMO run.
- Three-service Docker layout: engine, UI/overlay service, and TLS gateway.

See [known limitations](context/05_KNOWN_ISSUES.md) before production use. In particular, the live server currently uses DSTNS analytical traffic state; the exported SUMO scenario is integration-tested, but live in-process libsumo telemetry coupling remains a release gap.

## Prerequisites

- CMake 3.22+, a C++20 compiler, SQLite 3 development files
- Node.js 22+ and npm
- SUMO + `netconvert` for the SUMO integration test
- Docker Desktop for the container stack

On macOS with the supplied local toolchain, SUMO is detected from `PATH`.

## Build and test

```bash
./scripts/build.sh
./scripts/test.sh
```

Equivalent native commands:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j4
ctest --test-dir build --output-on-failure
npm test --prefix ui-engine
npm run build --prefix ui-engine
python3 tests/api/api_smoke.py --server build/dstns_server
tests/integration/sumo_smoke.sh
./build/dstns_replay_verify
./build/dstns_benchmark
```

## Standalone CLI Tools

- `build/dstns_scenario_export <output_dir>`: Compiles and exports scenario into SUMO XML files (`network.nod.xml`, `network.edg.xml`, `routes.rou.xml`, `sandbox.sumocfg`).
- `build/dstns_road_index <osm_file.xml> [max_nodes]`: Ingests and indexes OSM XML road networks.
- `build/dstns_replay_verify [seed]`: Verifies bit-for-bit graph and scenario hash reproduction and seek state reconstruction.
- `build/dstns_benchmark [grid_dim]`: Benchmarks scenario compilation, A* routing, and snapshot creation throughput.


## Run locally

Terminal 1:

```bash
./build/dstns_server --host 127.0.0.1 --port 8090 --logs logs
```

Terminal 2:

```bash
npm run dev --prefix ui-engine
```

Open `http://127.0.0.1:5173`. The server starts in `IDLE`; start the simulation in the UI or via:

```bash
curl -X POST http://127.0.0.1:8090/api/v1/playback/start \
  -H 'Content-Type: application/json' \
  -d '{"seed":"0x123456789ABCDEF0","playback_duration_seconds":1200,"day":0,"tick_rate":1,"dws":{"frequency":4}}'
```

The operator launcher supports menus and noninteractive server mode:

```bash
python3 launcher.py
python3 launcher.py --mode server
python3 launcher.py test all
python3 launcher.py sumo
```

## Docker and HTTPS

```bash
docker compose -f docker/docker-compose.yml up --build
```

Open `https://localhost:8443`. The gateway creates a seven-day self-signed development certificate if none is mounted. Browser trust warnings are expected for that certificate. Do not use it as a production certificate.

## Runtime model

```text
OSM/fixture -> road filter -> seeded bounded region -> bidirectional canonical graph
            -> stops/buildings/signals -> traffic + DWS schedules -> scenario hashes
            -> single-writer fixed-step state -> immutable API snapshots -> UI
            -> SUMO plain XML -> netconvert -> headless or microscopic execution
```

Playback compresses one 86,400-second virtual day into 60–1,200 real seconds. `tick_rate` multiplies the target virtual rate and is constrained to `(0, 10]`. Physics advances in fixed virtual increments; lag is caught up, never skipped.

## OSM input

Start requests may set a local immutable OSM XML snapshot:

```json
{"map":{"osm_file":"/data/region.osm.xml","max_nodes":50000}}
```

Only allowlisted road ways and referenced nodes enter the graph. `access=no/private` ways are excluded. Source files should be frozen and hash-managed. Planet/PBF indexing is specified but not implemented in this build.

## API

- Engine: `http://127.0.0.1:8090`
- OpenAPI: [api/openapi.yaml](api/openapi.yaml)
- Human documentation: [docs/api/README.md](docs/api/README.md)
- UI overlay service: `http://127.0.0.1:4173/api/v1/ui-overlay/*` in production UI-server mode

All normal runtime payloads carry API/run/revision/clock context. Errors are structured and never expose raw exception traces.

## Reproducibility

Base identity is the global seed + resolved configuration + frozen map snapshot + algorithm/build manifest. Interactive identity additionally includes the ordered control journal. `GET /api/v1/view/manifest` exposes the current hashes. See [REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md).

## Repository map

- `include/dstns`, `src`: C++ engine
- `apps/dstns_server`: API process
- `ui-engine`: separate observer/controller and optional visual-overlay API
- `tests`: native, OSM, replay, API lifecycle, SUMO integration
- `config`: data-driven defaults/profiles
- `docker`: container and TLS gateway definitions
- `docs`: human engineering documentation
- `context`: authoritative specs and future-agent handoff state
- `tools/scenario-inspect`: reproducible scenario/SUMO exporter

## Security notes

The local development API permits CORS from any origin and has no control token. Place it behind the provided gateway only for local use. Production deployment must set an origin allowlist, authenticate mutation/terminate routes, install managed TLS certificates, rate-limit controls, and restrict local OSM paths. See [SECURITY.md](docs/SECURITY.md).

## Troubleshooting

- `cannot open OSM XML`: mount/use an absolute path visible to the engine.
- UI says `ENGINE OFFLINE`: ensure port 8090 is listening or set `VITE_DSTNS_API_URL`.
- Empty map: start a run; the server intentionally boots idle.
- `netconvert` not found: install SUMO and add its `bin` directory to `PATH`.
- Docker certificate warning: the bundled flow creates a self-signed development certificate.

The detailed failure matrix is in [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
