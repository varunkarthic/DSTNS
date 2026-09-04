# DSTNS System Architecture

DSTNS (Deterministic Spatiotemporal Transport Network Simulator) couples deterministic scenario compilation, spatiotemporal graph dynamics, and microscopic traffic simulation into an observable, reproducible platform.

```
                  +-----------------------------------+
                  |        Global Seed (128-bit)      |
                  +-----------------------------------+
                                    |
            +-----------------------+-----------------------+
            |                       |                       |
            v                       v                       v
     [ Map Selection ]       [ Bus Stop Gen ]       [ DWS Weather Gen ]
     (OSM / CRFG / DRNCP)    (Graph Distance)       (Compact Kernels)
            |                       |                       |
            +-----------------------+-----------------------+
                                    |
                                    v
                     +-----------------------------+
                     |      Scenario Compiler      |
                     |  (Nodes, Edges, Hashes)     |
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
   (REST / SSE Snapshot Stream)                    (netconvert / libsumo)
            |
            v
   [ React UI Engine (MapLibre GL) ]
```

## Key Architectural Principles
1. **Determinism by Construction**: Counter-addressed Philox RNG domains isolate subsystem draws.
2. **Canonical Identifiers**: 0-indexed contiguous `NodeId` and `EdgeId` sequences are assigned only after deterministic spatial and topological sorting.
3. **Single-Writer Concurrency**: Only the simulation thread mutates dynamic simulation state; API threads submit requests to a synchronized command queue.
4. **Decoupled Visualization**: The React / MapLibre UI engine receives complete topological structures once and streams lightweight dynamic state vectors every second.
