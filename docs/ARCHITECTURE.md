# DSTNS System Architecture

DSTNS (Deterministic Spatiotemporal Transport Network Simulator) couples deterministic scenario compilation, spatiotemporal graph dynamics, and microscopic traffic simulation into an observable, reproducible platform.

---

## 1. End-to-End System Pipeline

```text
                  +-----------------------------------+
                  |       Master Seed (128-bit)       |
                  +-----------------------------------+
                                    |
      +-----------------------------+-----------------------------+
      |                             |                             |
      v                             v                             v
[ Map Sub-Seed ]             [ DWS Sub-Seed ]             [ Incident Sub-Seed ]
(SHA256: "map")              (SHA256: "dws")              (SHA256: "incidents")
      |                             |                             |
      v                             v                             v
[ City Catalog / OSM ]       [ Wendland Storms ]          [ Incident Schedule ]
(16 World Metropolises)      (Deterministic Rain)         (>= 4 Incidents / Day)
      |                             |                             |
      +-----------------------------+-----------------------------+
                                    |
                                    v
                     +-----------------------------+
                     |      Scenario Compiler      |
                     |  (Nodes, Edges, Facilities) |
                     +-----------------------------+
                                    |
                                    v
                     +-----------------------------+
                     |         GraphStore          |
                     |  Static / Dynamic Vectors   |
                     +-----------------------------+
                                    |
            +-----------------------+-----------------------+
            |                                               |
            v                                               v
   [ Single-Writer Engine ]                        [ SUMO Net Export ]
   (Fixed-Step Integration)                        (Plain XML / Config)
            |                                               |
            v                                               v
   [ API Server (cpp-httplib) ]                    [ SUMO Microscopic ]
   (REST & Snapshot Telemetry)                     (netconvert / libsumo)
            |
            v
   [ React UI Engine (MapLibre GL) ]
   (Canvas, Controls, Reports)
```

---

## 2. Core Architectural Principles

1. **Determinism by Construction**:
   - Master 128-bit seed cryptographically derives independent sub-seeds (`map`, `dws`, `traffic`, `incidents`, `events`, `scenario`) via SHA-256.
   - Counter-addressed Philox PRNG guarantees bit-for-bit identical outcomes across compilers and architectures.
   - Elimination of all runtime unseeded entropy (`std::rand()`, clock time).
2. **Canonical Entity Identifiers**:
   - Contiguous 0-indexed integer identifiers (`NodeId`, `EdgeId`) assigned after deterministic geometric and topological sorting (DRNCP).
3. **Single-Writer Concurrency**:
   - Only the dedicated simulation thread mutates dynamic simulation state; API threads submit requests to a synchronized command queue.
4. **Complete Reset Isolation**:
   - Simulation resets completely purge all dynamic state, manual weather cells, traffic surges, dispatched transit buses, signal overrides, and reset monotonic ID counters.
5. **Decoupled Architecture & Observation**:
   - Static topology is fetched once via `/api/v1/view/topology`; high-frequency telemetry vectors stream via `/api/v1/view/snapshot`.

---

## 3. Subsystem Deep-Dives

- [Deterministic Seeding & Sub-Seed Derivation](deterministic-seeding.md)
- [OpenStreetMap Ingestion & City Catalog](osm-map-generation.md)
- [Deterministic Weather Simulation (DWS)](dws.md)
- [Incident Subsystem & Physical Attenuation](incidents.md)
- [Simulation Engine & State Management](simulation-engine.md)
- [Event Stack & Telemetry Engine](events.md)
- [Playback Controller & Simulation Lifecycle](playback-control.md)
- [Spatiotemporal Graph Model](graph-model.md)
- [Routing Engine & Shortest Paths](routing.md)
- [Unified REST API Reference](api.md)
- [Docker & Containerized Deployment](DOCKER.md)
- [Testing Architecture & Quality Assurance](TESTING.md)
